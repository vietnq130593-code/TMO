/**
 * ALISTA — Scheduler nền (v1.1)
 * ===============================
 * Tick 60s trong process Next.js (được PM2 duy trì):
 *   - Đọc CronJob row executor='ALISTA' (owner pause được từ UI Automation)
 *   - Cửa sổ 23:30-23:59 giờ VN (Asia/Ho_Chi_Minh) — gate 1 lần/ngày
 *   - Tính deadline 05:30 hôm sau (giờ VN) → truyền vào pipeline (budget 6h)
 *   - Gọi runComprehensiveCheck({trigger:'cron-nightly', deadlineMs})
 *
 * Toàn bộ múi giờ qua Intl.DateTimeFormat với timeZone 'Asia/Ho_Chi_Minh'
 * tường minh — không phụ thuộc đồng hồ server (sandbox chạy UTC).
 *
 * Chống chạy kép có chủ đích:
 *   - agentId='alista' (≠'default') → automation-engine loop B (chỉ xử lý
 *     agentId='default') bỏ qua; không set field `task` → mini-service loop A
 *     (cần task) bỏ qua. Chỉ scheduler nền này làm executor duy nhất.
 */

import { ensureDbReady } from '@/lib/db-setup'
import { db } from '@/lib/db'
import { runComprehensiveCheck } from './comprehensive-check'

// ==================== CONSTANTS ====================

const ALISTA_TICK_MS = 60_000
const ALISTA_TZ = 'Asia/Ho_Chi_Minh' // UTC+7 — owner directive
const ALISTA_AGENT_ID = 'alista'
const ALISTA_EXECUTOR = 'ALISTA'

// ==================== GLOBAL GUARD (chống HMR double) ====================

const GLOBAL_KEY = '__alistaSchedulerStarted'
type GlobalShape = { [GLOBAL_KEY]?: boolean }

function isSchedulerStarted(): boolean {
  return !!(globalThis as unknown as GlobalShape)[GLOBAL_KEY]
}
function markSchedulerStarted(): void {
  ;(globalThis as unknown as GlobalShape)[GLOBAL_KEY] = true
}

// ==================== TIMEZONE HELPERS ====================

/** Lấy giờ hiện tại theo tz HN — {HH, mm, dateStr (YYYY-MM-DD)} */
function getHNNow(): { HH: number; mm: number; dateStr: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ALISTA_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const HH = parseInt(get('hour'), 10)
  const mm = parseInt(get('minute'), 10)
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`
  return { HH: Number.isFinite(HH) ? HH : 0, mm: Number.isFinite(mm) ? mm : 0, dateStr }
}

/** Bắt đầu "hôm nay" theo tz HN — Date object ở 00:00:00+07:00 */
function startOfTodayHN(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+07:00`)
}

/** Deadline 05:30 hôm sau theo tz HN (23:30 + 6h) */
function computeNightlyDeadline(dateStr: string): number {
  // dateStr là "hôm nay" theo HN → deadline = "hôm nay 05:30 + 1 ngày"
  // Tức là hôm sau 05:30 — nhưng vì cửa sổ chạy là 23:30-23:59 hôm nay,
  // deadline 05:30 hôm sau là "hôm nay + 6h".
  // Để cản pipeline chạy quá 05:30 hôm sau, ta tính:
  //   startOfTodayHN + 23h30 (window start) + 6h = 05:30 hôm sau
  // Hoặc đơn giản: new Date(`${dateStr}T05:30:00+07:00`).getTime() + 24h
  const startOfToday = startOfTodayHN(dateStr)
  // deadline = startOfToday + 23h30 + 6h = startOfToday + 29h30
  return startOfToday.getTime() + (29 * 3600_000 + 30 * 60_000)
}

/** Tính nextRunAt cho CronJob — 23:30 hôm sau theo tz HN */
function computeNextRunAt(dateStr: string): Date {
  // Hôm nay 23:30 — nếu đã qua (sau 23:59), thì hôm sau 23:30
  // Đơn giản: hôm nay 23:30 + 24h (đảm bảo sau này)
  const today = startOfTodayHN(dateStr)
  return new Date(today.getTime() + 24 * 3600_000 + 23 * 3600_000 + 30 * 60_000)
}

// ==================== CRON JOB REGISTRY ====================

/** Đảm bảo CronJob row tồn tại (idempotent — chạy trong tick đầu) */
export async function ensureAlistaCronJob(): Promise<void> {
  try {
    const existing = await db.cronJob.findFirst({
      where: { executor: ALISTA_EXECUTOR },
    })
    if (existing) {
      // Cập nhật nextRunAt nếu null hoặc quá khứ (idempotent self-heal)
      if (!existing.nextRunAt || existing.nextRunAt < new Date()) {
        const { dateStr } = getHNNow()
        await db.cronJob.update({
          where: { id: existing.id },
          data: {
            nextRunAt: computeNextRunAt(dateStr),
            status: existing.status === 'paused' ? 'paused' : 'active',
          },
        }).catch(() => { /* fail-open */ })
      }
      return
    }
    // Tạo mới
    const { dateStr } = getHNNow()
    await db.cronJob.create({
      data: {
        agentId: ALISTA_AGENT_ID, // ≠'default' → automation-engine loop B bỏ qua
        expression: '30 23 * * *',
        expr: '30 23 * * *',
        kind: 'cron',
        tz: ALISTA_TZ,
        taskPrompt: 'ALISTA — Kiểm tra toàn diện hệ thống hàng đêm (23h30-05:30 budget 6h, 7 nhiệm vụ tuần tự)',
        task: '', // KHÔNG set task → mini-service loop A (cần task) bỏ qua
        executor: ALISTA_EXECUTOR, // scheduler nền là executor duy nhất
        scheduleJson: JSON.stringify({
          mode: 'day', times: ['23:30'], repeat: true, budget: '6h', deadline: '05:30',
        }),
        enabled: true,
        status: 'active',
        nextRunAt: computeNextRunAt(dateStr),
      },
    })
    console.log(`[ALISTA][scheduler] Đã tạo CronJob row executor='${ALISTA_EXECUTOR}' — cửa sổ 23:30-23:59 (tz HN), nextRunAt=${computeNextRunAt(dateStr).toISOString()}`)
  } catch (err) {
    console.warn('[ALISTA][scheduler] ensureAlistaCronJob fail (không chặn boot):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== TICK ====================

/** 1 tick (60s) — chạy toàn bộ gate + (nếu đúng cửa sổ) pipeline */
async function alistaTick(tickNo: number): Promise<void> {
  try {
    // (1) Đảm bảo CronJob row tồn tại (idempotent — chỉ tạo lần đầu)
    if (tickNo === 1) {
      await ensureAlistaCronJob()
    }

    // (2) Đọc CronJob row — owner có thể pause từ UI
    const job = await db.cronJob.findFirst({ where: { executor: ALISTA_EXECUTOR } })
    if (!job || !job.enabled || job.status !== 'active') {
      return // Owner paused hoặc chưa cấu hình — không chạy
    }

    // (3) Gate cửa sổ 23:30-23:59 (giờ VN) — chịu restart, trễ vẫn chạy
    const { HH, mm, dateStr } = getHNNow()
    if (HH !== 23 || mm < 30) return

    // (4) Gate 1 lần/ngày — đã chạy hôm nay chưa?
    const startOfToday = startOfTodayHN(dateStr)
    const ranToday = await db.taskExecution.findFirst({
      where: {
        type: 'alista-check',
        startedAt: { gte: startOfToday },
      },
      select: { id: true, status: true, startedAt: true },
    })
    if (ranToday) {
      // Đã chạy hôm nay — skip (chống chạy kép nếu restart nhiều lần trong cửa sổ)
      return
    }

    // (5) Tính deadline 6h — 05:30 hôm sau (giờ VN)
    const deadlineMs = computeNightlyDeadline(dateStr)

    // (6) Cập nhật lastRunAt + nextRunAt
    try {
      await db.cronJob.update({
        where: { id: job.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: computeNextRunAt(dateStr),
        },
      })
    } catch { /* fail-open */ }

    // (7) CHẠY PIPELINE — fire-and-forget (không await để tick sau không bị block)
    console.log(`[ALISTA][scheduler] tick #${tickNo}: cửa sổ 23:30-${HH === 23 && mm < 60 ? '23:59' : '...'} (tz HN) → chạy comprehensive check (deadline 05:30 hôm sau)`)
    void runComprehensiveCheck({
      trigger: 'cron-nightly',
      deadlineMs,
      force: false,
    }).then((result) => {
      console.log(`[ALISTA][scheduler] tick #${tickNo}: hoàn tất — ${result.proposalsCreated.length} proposal, ${result.durationMs}ms, deadlineMet=${result.deadlineMet}, reason=${result.reason}`)
    }).catch((err) => {
      console.error(`[ALISTA][scheduler] tick #${tickNo}: pipeline lỗi —`, err instanceof Error ? err.message : String(err))
    })
  } catch (err) {
    // Fail-open: tick lỗi thì tick sau sẽ thử lại — không throw phá interval
    console.warn(`[ALISTA][scheduler] tick #${tickNo} lỗi (bỏ qua, chờ tick sau):`, err instanceof Error ? err.message : String(err))
  }
}

// ==================== START SCHEDULER ====================

/**
 * Khởi động scheduler nền — gọi từ instrumentation-node.ts (mẫu Self-Direction).
 * globalThis guard chống double-register khi Next dev HMR reload.
 */
export function startAlistaScheduler(): void {
  if (isSchedulerStarted()) {
    console.log('[ALISTA][scheduler] Đã khởi động rồi (globalThis guard) — skip')
    return
  }
  markSchedulerStarted()

  let tickCount = 0
  const tick = async () => {
    const tickNo = ++tickCount
    await alistaTick(tickNo)
    // Heartbeat: tick đầu tiên (chứng minh interval sống ngay sau boot) +
    // mỗi 15 tick (15 phút) — heartbeat định kỳ cho ops theo dõi scheduler.
    if (tickNo === 1 || tickNo % 15 === 0) {
      console.log(`[ALISTA][scheduler] heartbeat tick #${tickNo} — scheduler sống`)
    }
  }

  // Lần đầu: đợi DB self-heal xong rồi mới tick (tránh đập vào DB chưa migrate)
  void ensureDbReady()
    .then(() => new Promise((r) => setTimeout(r, 15_000))) // delay 15s
    .then(() => {
      console.log('[ALISTA][scheduler] Bật scheduler nền (60s/tick) — cửa sổ 23:30-23:59 (tz HN), budget 6h, deadline 05:30 hôm sau')
      void tick()
      setInterval(() => void tick(), ALISTA_TICK_MS)
    })
    .catch(() => {
      // ensureDbReady hiếm khi reject — nhưng nếu có, vẫn bật scheduler (tick
      // có try/catch riêng + API will self-heal khi có request)
      console.warn('[ALISTA][scheduler] DB warm-up lỗi — bật scheduler ở chế độ thường trực')
      void tick()
      setInterval(() => void tick(), ALISTA_TICK_MS)
    })
}
