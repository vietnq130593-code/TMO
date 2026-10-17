/**
 * ALISTA — Scheduler nền (v1.2)
 * ===============================
 * Tick 60s trong process Next.js (được PM2 duy trì):
 *   - Đọc CronJob row executor='ALISTA' (owner pause được từ UI Automation)
 *   - Cửa sổ ca trực 23:30 → 05:30 hôm sau (giờ VN, Asia/Ho_Chi_Minh) —
 *     FIX v1.2: mở rộng catch-up — server down lúc 23:30-23:59 rồi lên lại
 *     trong đêm vẫn chạy ca trực đó (trước đây trượt cửa sổ = mất cả ngày).
 *   - Gate 1-lần/ca: theo CronJob.lastRunAt (FIX v1.2: trước đây gate theo
 *     TaskExecution 'alista-check' hôm nay → 1 lần manual ban ngày LÀM ẾCH
 *     ca trực 23h30).
 *   - Tính deadline 05:30 hôm sau (anchor 23:30 + 6h budget cứng)
 *   - Gọi runComprehensiveCheck({trigger:'cron-nightly', deadlineMs})
 *   - FIX v1.2: dọn TaskExecution 'alista-check' zombie (process chết giữa
 *     ca → row kẹt 'running') + SWEEP follow-up verification 60s (v1.2 —
 *     lưới an toàn cho hook hoàn tất proposal, xem proposal-verify.ts).
 *
 * Toàn bộ múi giờ qua Intl.DateTimeFormat với timeZone 'Asia/Ho_Chi_Minh'
 * tường minh — không phụ thuộc đồng hồ server (sandbox chạy UTC).
 *
 * Chống chạy kép có chủ đích (và mini-service cron-scheduler v1.2 đã filter
 * executor='' nên không còn bắn nhầm row này):
 *   - agentId='alista' (≠'default') → automation-engine loop B bỏ qua
 *   - executor='ALISTA' → mini-service cron-scheduler tick bỏ qua
 *     (FIX v1.2: kèm guard trong executeCronJob — phòng đường POST /jobs/:id/run)
 *   - In-flight guard __alistaCheckInFlight chống manual + nightly đè nhau
 */

import { ensureDbReady } from '@/lib/db-setup'
import { db } from '@/lib/db'
import { runComprehensiveCheck, isAlistaCheckInFlight, getCheckState } from './comprehensive-check'
import { sweepCompletedAlistaProposals } from './proposal-verify'
// P3-c (task 31-f): backup SQLite hằng ngày 03:00 VN — executor chạy trong tick
// này (executor='DB-BACKUP' — row riêng, owner pause độc lập với ca trực ALISTA)
import { dailyBackupTick, ensureDailyBackupCronJob } from './db-backup'

// ==================== CONSTANTS ====================

const ALISTA_TICK_MS = 60_000
const ALISTA_TZ = 'Asia/Ho_Chi_Minh' // UTC+7 — owner directive
const ALISTA_AGENT_ID = 'alista'
const ALISTA_EXECUTOR = 'ALISTA'

/** Ca trực bắt đầu 23:30 VN; budget 6h → deadline 05:30 hôm sau */
const SHIFT_START_MIN = 23 * 60 + 30 // 23:30
const SHIFT_BUDGET_MS = 6 * 3600_000 // 6h
/** Catch-up: cần ≥30' budget còn lại mới chạy (ít hơn → đợi ca sau) */
const MIN_CATCHUP_REMAINING_MS = 30 * 60_000
/** Zombie sweep: row 'running' quá deadline + 2' → đánh dấu failed (process chết) */
const ZOMBIE_GRACE_MS = 2 * 60_000

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

/** Cộng/trừ ngày trên chuỗi YYYY-MM-DD (UTC-safe string math) */
function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Anchor của ca trực đang mở — FIX v1.2:
 *   - 23:30-23:59 hôm nay → anchor = hôm nay (ca trực mới bắt đầu)
 *   - 00:00-05:30 hôm sau → anchor = HÔM QUA (catch-up ca trực 23:30 hôm qua —
 *     server down lúc 23:30 rồi lên lại trong đêm vẫn chạy được ca đó)
 *   - Ngoài 2 khoảng trên → null (không ca trực nào đang mở)
 */
function getShiftAnchor(hn: ReturnType<typeof getHNNow>): string | null {
  const minutesNow = hn.HH * 60 + hn.mm
  // 23:30 → 23:59 hôm nay
  if (hn.HH === 23 && minutesNow >= SHIFT_START_MIN) return hn.dateStr
  // 00:00 → 05:30 hôm sau (catch-up cho ca trực của hôm qua)
  if (hn.HH < 5 || (hn.HH === 5 && hn.mm <= 30)) return shiftDateStr(hn.dateStr, -1)
  return null
}

/**
 * Tính nextRunAt cho CronJob — 23:30 kế tiếp theo tz HN.
 * FIX v1.2: trước đây luôn trả "hôm sau 23:30" → lúc 10:00 sáng UI hiện
 * nextRun sai (thực tế tối nay 23:30 là chạy gần nhất).
 */
function computeNextRunAt(dateStr: string): Date {
  const today = startOfTodayHN(dateStr)
  const tonightStart = today.getTime() + SHIFT_START_MIN * 60_000
  // Nếu CHƯA tới 23:30 hôm nay → next là tối nay 23:30; đã qua → mai 23:30
  const next = tonightStart > Date.now() ? tonightStart : tonightStart + 24 * 3600_000
  return new Date(next)
}

// ==================== CRON JOB REGISTRY ====================

/** Đảm bảo CronJob row tồn tại (idempotent — chạy trong tick đầu) */
export async function ensureAlistaCronJob(): Promise<void> {
  try {
    const existing = await db.cronJob.findFirst({
      where: { executor: ALISTA_EXECUTOR },
    })
    if (existing) {
      // FIX v1.2: tự lành cả status='failed' (đề phòng mini-service cũ đã đánh
      // fail trước khi fix executor filter) + nextRunAt null/quá khứ.
      // FIX v1.2b: nextRunAt lệch khỏi "23:30 VN kế tiếp" (vd bản cũ ghi
      // "hôm sau 23:30" dù tối nay 23:30 chưa tới) cũng được canh về đúng.
      const nextRun = computeNextRunAt(getHNNow().dateStr)
      const needsHeal =
        !existing.nextRunAt ||
        existing.nextRunAt < new Date() ||
        existing.status === 'failed' ||
        existing.nextRunAt.getTime() !== nextRun.getTime()
      if (needsHeal) {
        await db.cronJob.update({
          where: { id: existing.id },
          data: {
            nextRunAt: nextRun,
            status: existing.status === 'paused' ? 'paused' : 'active',
            lastError: null,
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
        task: '', // KHÔNG set task — row chỉ để hiển thị/pause trong UI Automation
        executor: ALISTA_EXECUTOR, // scheduler nền là executor duy nhất
        scheduleJson: JSON.stringify({
          mode: 'day', times: ['23:30'], repeat: true, budget: '6h', deadline: '05:30',
          window: '23:30→05:30+1 (catch-up)', followUpVerify: '60s sweep',
        }),
        enabled: true,
        status: 'active',
        nextRunAt: computeNextRunAt(dateStr),
      },
    })
    console.log(`[ALISTA][scheduler] Đã tạo CronJob row executor='${ALISTA_EXECUTOR}' — cửa sổ 23:30→05:30+1 (tz HN), nextRunAt=${computeNextRunAt(dateStr).toISOString()}`)
  } catch (err) {
    console.warn('[ALISTA][scheduler] ensureAlistaCronJob fail (không chặn boot):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== SWEEP: ZOMBIE ROW + FOLLOW-UP VERIFY ====================

/**
 * FIX v1.2: dọn TaskExecution 'alista-check' kẹt 'running' sau khi process chết
 * (deadline trong result đã qua + không còn in-flight trong Map) → 'failed'.
 * Chống: gate lượt chạy sau nhìn row 'running' mà tưởng đang chạy.
 */
async function sweepZombieChecks(): Promise<void> {
  try {
    const running = await db.taskExecution.findMany({
      where: { type: 'alista-check', status: 'running' },
      select: { id: true, result: true },
      take: 20,
    })
    for (const r of running) {
      try {
        const parsed = JSON.parse(r.result || '{}') as { checkId?: string; deadlineMs?: number }
        // Còn sống trong state Map → không phải zombie
        if (parsed.checkId && getCheckState(parsed.checkId)?.status === 'running') continue
        const dl = typeof parsed.deadlineMs === 'number' ? parsed.deadlineMs : 0
        if (dl && Date.now() > dl + ZOMBIE_GRACE_MS) {
          await db.taskExecution.update({
            where: { id: r.id },
            data: {
              status: 'failed',
              completedAt: new Date(),
              errorMessage: 'orphaned — process restart giữa ca trực (zombie sweep)',
            },
          })
          console.warn(`[ALISTA][scheduler] zombie sweep: TaskExecution ${r.id} kẹt 'running' quá deadline → đánh dấu failed`)
        }
      } catch { /* row cũ parse fail → bỏ qua */ }
    }
  } catch { /* fail-open */ }
}

// ==================== TICK ====================

/** 1 tick (60s) — sweep + gate + (nếu đúng cửa sổ) pipeline */
async function alistaTick(tickNo: number): Promise<void> {
  try {
    // (1) Đảm bảo CronJob row tồn tại (idempotent — chỉ tạo lần đầu)
    if (tickNo === 1) {
      await ensureAlistaCronJob()
    }

    // (1b) FIX v1.2 — sweep follow-up verification MỖI TICK (lưới an toàn 60s
    // cho hook hoàn tất proposal; hook in-process vẫn là đường tức thời chính)
    const notified = await sweepCompletedAlistaProposals()

    // (1c) FIX v1.2 — zombie sweep TaskExecution kẹt 'running'
    await sweepZombieChecks()

    // (1d) P3-c (task 31-f) — Daily SQLite backup 03:00 VN: đảm bảo row tồn tại
    // (tick đầu, idempotent — như ensureAlistaCronJob) rồi gate + bắn backup
    // mỗi tick. ĐẶT TRƯỚC mọi early-return của ca trực ALISTA: backup có lịch
    // riêng (03:00) và catch-up phải chạy được cả ngoài cửa sổ 23:30-05:30.
    // dailyBackupTick fail-open tuyệt đối — không bao giờ phá tick ALISTA.
    if (tickNo === 1) {
      await ensureDailyBackupCronJob()
    }
    await dailyBackupTick(tickNo)


    // (2) Đọc CronJob row — owner có thể pause từ UI
    const job = await db.cronJob.findFirst({ where: { executor: ALISTA_EXECUTOR } })
    if (!job || !job.enabled || job.status !== 'active') {
      return // Owner paused hoặc chưa cấu hình — không chạy (sweep vẫn đã chạy)
    }

    // (3) FIX v1.2 — cửa sổ ca trực 23:30 → 05:30+1 (giờ VN) + anchor catch-up
    const hn = getHNNow()
    const anchor = getShiftAnchor(hn)
    if (!anchor) return // Ngoài ca trực — không chạy pipeline

    const shiftStartMs = startOfTodayHN(anchor).getTime() + SHIFT_START_MIN * 60_000 // anchor 23:30
    const deadlineMs = shiftStartMs + SHIFT_BUDGET_MS // anchor 23:30 + 6h = 05:30 hôm sau

    // (4) FIX v1.2 — gate 1-lần/ca theo CronJob.lastRunAt (KHÔNG theo TaskExecution
    // 'alista-check' — chạy manual ban ngày không còn làm ếch ca trực 23h30)
    if (job.lastRunAt && job.lastRunAt.getTime() >= shiftStartMs) {
      return // Ca trực anchor này đã bắn rồi (chống re-fire khi restart trong ca)
    }

    // (5) In-flight guard — đang có pipeline chạy (manual/nightly) → đợi tick sau
    const inFlight = isAlistaCheckInFlight()
    if (inFlight) {
      console.log(`[ALISTA][scheduler] tick #${tickNo}: pipeline đang chạy (checkId=${inFlight}) — skip`)
      return
    }

    // (6) Catch-up đủ điều kiện: còn ≥30' budget (catch-up sát giờ không chạy nửa ca)
    const remaining = deadlineMs - Date.now()
    const isCatchup = hn.dateStr !== anchor // chạy trong khung 00:00-05:30 cho ca hôm qua
    if (isCatchup && remaining < MIN_CATCHUP_REMAINING_MS) {
      return // Quá sát 05:30 — đợi ca trực mai
    }

    // (7) Cập nhật lastRunAt + nextRunAt TRƯỚC khi bắn (chống re-fire nếu restart ngay)
    try {
      await db.cronJob.update({
        where: { id: job.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: computeNextRunAt(hn.dateStr),
        },
      })
    } catch { /* fail-open */ }

    // (8) CHẠY PIPELINE — fire-and-forget (không await để tick sau không bị block)
    console.log(
      `[ALISTA][scheduler] tick #${tickNo}: ca trực anchor ${anchor} 23:30 VN${isCatchup ? ' (CATCH-UP — trễ do server down lúc 23:30)' : ''} → ` +
      `chạy comprehensive check (deadline 05:30 hôm sau, còn ${Math.round(remaining / 60_000)}' budget)` +
      (notified > 0 ? ` · sweep đã notify ${notified} đề xuất hoàn tất` : ''),
    )
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
      console.log('[ALISTA][scheduler] Bật scheduler nền (60s/tick) — cửa sổ 23:30→05:30+1 catch-up (tz HN), budget 6h, deadline 05:30 + sweep follow-up 60s')
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
