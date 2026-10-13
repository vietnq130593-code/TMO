/**
 * GAP-2 (Task 26-BE — GIAO_THUC_GIAM_SAT_AGENTS.md D1.1/D1.4 +
 * BLUEPRINT-HYPERNAS-P1-P5 §4.2-2b) — CẢNH BÁO CHỦ ĐỘNG
 * ==========================================================================
 *
 * `runAlertChecks()` — 4 rule (3 cảnh báo + 1 dọn mồ côi Task 32) chạy trong
 * tick 10 phút của worker impact.ts (CÙNG setInterval — KHÔNG timer mới; gọi
 * NGAY SAU pass impact; static import an toàn vì alerts KHÔNG import ngược
 * impact):
 *
 *   1. STALL (D1.1 — phát stall trong ≤ 15 phút): AgentRunRecord
 *      status='running' mà mốc hoạt động cuối (createdAt — AgentRunRecord
 *      KHÔNG có cột updatedAt, đọc schema dòng ~1190-1231) cũ hơn 15 phút
 *      VÀ không có ObservationEvent nào của runId đó (cột runId THẬT — model
 *      103 có cột này, không cần lọc payloadJson) trong 15 phút qua.
 *   2. TOKEN-BURN (D1.4 — alert + bản ghi phân tích): run VỪA kết thúc
 *      (status terminal: completed/failed/cancelled/incomplete — enum thật
 *      trong schema dòng ~1211) với tokensUsed > 500.000 và kết thúc trong
 *      cửa sổ tick ~15 phút (để không báo lại run cũ sau restart — bản ghi
 *      được ghi lúc run kết thúc nên mốc = completedAt ?? createdAt). Payload
 *      mang đủ số liệu cho post-mortem — sự kiện obs.alert CHÍNH LÀ bản ghi
 *      phân tích D1.4 yêu cầu.
 *   3. JOB HEARTBEAT STALE: (a) BrainSearchRun status='running' mà
 *      heartbeatAt cũ hơn 30 phút — session mồ côi (blueprint HyperNAS
 *      §4.2-2b); (b) CronJob enabled + status='active' mà nextRunAt quá hạn
 *      > 60 phút chưa chạy (schema CronJob ĐỦ trường để đánh giá chắc chắn:
 *      enabled/status/nextRunAt — không phải đoán).
 *   4. ORPHAN SWEEP (Task 32 — D1.2): AgentRunRecord 'running' > 30 phút mà
 *      runId KHÔNG còn sống trong bộ nhớ process (isRunIdActiveInMemory) →
 *      đánh dấu failed/crashed + obs.alert rule orphan-sweep. Đóng sổ mồ côi
 *      giữa phiên — boot sweeper chỉ lo lúc khởi động.
 *
 * Cờ: `obs_alerts` (TUNING_SPECS thứ 30 — off mặc định) check MỖI vòng —
 * off → return ngay (rẻ); bật/tắt có hiệu lực NGAY, không restart.
 * Cờ `obs_ledger` off → VẪN console.warn ([OBS-ALERT]) nhưng sự kiện
 * KHÔNG được ghi — observeEvent tự gate theo cờ ở ledger.ts (fail-open theo
 * thiết kế; dedup query-based lúc đó rơi về lớp in-memory).
 *
 * Mỗi rule fail-open + dedup ≤ 1 alert mỗi (rule, targetId) mỗi 1 GIỜ:
 *   - Lớp in-memory lastAlertAt (globalThis — sống sót HMR): chặn spam khi
 *     sự kiện không ghi được (obs_ledger off) — vẫn tôn trọng ngưỡng 1h.
 *   - Lớp query: obs.alert 1 giờ gần nhất trùng (rule, targetId) trong
 *     payload — chính thức qua restart.
 * Phần quyết định tách HẰNG pure (shouldAlertStall/shouldAlertTokenBurn/
 * isHeartbeatStale/shouldAlertCronOverdue) — rule engine chỉ lo query + IO;
 * test r99 pin biên trực tiếp. Mọi DB op try/catch — worker KHÔNG throw.
 */

import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'
import { observeEvent, flushObservationQueue } from './ledger'

// ==================== HẰNG SỐ (doctrine #1 — nguồn D1.1/D1.4/§4.2-2b) ====================

/** D1.1 — run "đóng băng" khi không hoạt động > 15 phút (strict). */
export const ALERT_STALL_AFTER_MS = 15 * 60_000
/** D1.4 — ngưỡng token-burn: tokensUsed > 500.000 (strict). */
export const ALERT_TOKEN_BURN_LIMIT = 500_000
/** Cửa sổ "vừa kết thúc" của token-burn (~15 phút — không báo lại run cũ sau restart). */
export const ALERT_TOKEN_BURN_WINDOW_MS = 15 * 60_000
/** HyperNAS §4.2-2b — session search mồ côi khi heartbeat cũ > 30 phút (strict). */
export const ALERT_HEARTBEAT_STALE_MS = 30 * 60_000
/** CronJob nextRunAt quá hạn > 60 phút mà chưa chạy (ngưỡng trung thực — schema đủ trường). */
export const ALERT_CRON_OVERDUE_MS = 60 * 60_000
/** Dedup: ≤ 1 alert mỗi (rule, targetId) mỗi 1 giờ. */
export const ALERT_DEDUP_WINDOW_MS = 60 * 60_000
/** Status terminal của AgentRunRecord (enum thật schema dòng ~1211 — 'running' là trạng thái sống duy nhất). */
export const ALERT_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'incomplete'] as const
/** Trần quét mỗi rule mỗi tick — chống burst (fail-open, tick sau tiếp). */
const SCAN_CAP_RUNS = 100
const SCAN_CAP_JOBS = 100
/**
 * GIAO_THUC-GS Task 32 — mồ côi khi DB row 'running' > 30 phút MÀ runId không
 * còn 'running' trong bộ nhớ process (isRunIdActiveInMemory) — tức run đã chết
 * giữa chừng (chat abort, exception trước endAgentRun, persist fail...) mà
 * không ai đóng sổ. 30 phút > ngưỡng stall 15' để chắc chắn không đụng run
 * LLM-call-dài còn sống (memory check đã chặn, đây là lớp chắn thứ 2).
 */
export const ALERT_ORPHAN_AFTER_MS = 30 * 60_000

// ==================== PURE — phần quyết định (test r99 pin biên) ====================

/**
 * D1.1 — stall khi mốc hoạt động cuối cũ HƠN 15 phút (strict: đúng 15 phút
 * chưa là "cũ hơn 15 phút"). lastActivityMs/now là epoch-ms.
 */
export function shouldAlertStall(lastActivityMs: number, now: number): boolean {
  return now - lastActivityMs > ALERT_STALL_AFTER_MS
}

/**
 * D1.4 — token-burn khi tokensUsed > 500.000 (strict: đúng 500.000 chưa chạm
 * ngưỡng) VÀ run vừa kết thúc trong cửa sổ ~15 phút (endedAt trong quá khứ,
 * cách now ≤ 15 phút — inclusive để run kết thúc đúng mép tick vẫn được báo).
 * endedAt TƯƠNG LAI (đồng hồ lệch/dữ liệu rác — clock skew) → false: không
 * báo trên mốc chưa xảy ra (pin r99-B2).
 */
export function shouldAlertTokenBurn(tokensUsed: number, endedAtMs: number, now: number): boolean {
  return (
    tokensUsed > ALERT_TOKEN_BURN_LIMIT
    && endedAtMs <= now
    && now - endedAtMs <= ALERT_TOKEN_BURN_WINDOW_MS
  )
}

/** HyperNAS §4.2-2b — heartbeat mồ côi khi cũ HƠN 30 phút (strict). */
export function isHeartbeatStale(heartbeatAtMs: number, now: number): boolean {
  return now - heartbeatAtMs > ALERT_HEARTBEAT_STALE_MS
}

/**
 * CronJob quá hạn khi nextRunAt đã qua > 60 phút (strict) mà chưa chạy —
 * nextRunAt null/tương lai → false (chưa đến giờ là KHÔNG quá hạn).
 */
export function shouldAlertCronOverdue(nextRunAtMs: number | null, now: number): boolean {
  if (typeof nextRunAtMs !== 'number' || !Number.isFinite(nextRunAtMs)) return false
  return now - nextRunAtMs > ALERT_CRON_OVERDUE_MS
}

// ==================== FLAG ====================

/** Cờ obs_alerts (STORE › ENV › DEFAULT=off) — check MỖI vòng, hiệu lực ngay. */
export function isObsAlertsEnabled(): boolean {
  try {
    return getTuningEnum('obs_alerts') === 'on'
  } catch {
    return false
  }
}

// ==================== STATE — dedup in-memory (globalThis — sống sót HMR) ====================

interface ObsAlertsState {
  /** `${rule}:${targetId}` → epoch-ms lần alert gần nhất (lớp dự phòng khi ledger off). */
  lastAlertAt: Map<string, number>
}

const globalForObsAlerts = globalThis as unknown as { __tmoObsAlerts?: ObsAlertsState }

function state(): ObsAlertsState {
  if (!globalForObsAlerts.__tmoObsAlerts) {
    globalForObsAlerts.__tmoObsAlerts = { lastAlertAt: new Map() }
  }
  return globalForObsAlerts.__tmoObsAlerts
}

/** Dọn dedup cho TEST (bun test 1 process — cô lập giữa các case/file). */
export function resetAlertDedupState(): void {
  try {
    state().lastAlertAt.clear()
  } catch {
    /* no-op */
  }
}

// ==================== DEDUP (2 lớp — xem header) ====================

async function isDuplicated(rule: string, targetId: string, now: number): Promise<boolean> {
  const key = `${rule}:${targetId}`
  const st = state()
  // Lớp in-memory — chặn spam cả khi sự kiện không ghi được (obs_ledger off)
  const last = st.lastAlertAt.get(key)
  if (typeof last === 'number' && now - last < ALERT_DEDUP_WINDOW_MS) return true
  // Lớp query — obs.alert 1 giờ gần nhất trùng (rule, targetId) trong payload
  try {
    const rows = await db.observationEvent.findMany({
      where: { kind: 'obs.alert', ts: { gte: new Date(now - ALERT_DEDUP_WINDOW_MS) } },
      select: { payloadJson: true },
      take: 200, // trần quét — 1h alert không nhiều
    })
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payloadJson) as { rule?: string; targetId?: string }
        if (p.rule === rule && p.targetId === targetId) {
          st.lastAlertAt.set(key, now)
          return true
        }
      } catch {
        /* payload rác — bỏ qua */
      }
    }
  } catch {
    return false // DB lỗi — coi như chưa từng alert (lớp memory đã chặn phần lớn)
  }
  return false
}

/** Đánh dấu đã alert (cả 2 lớp — query lớp nhớ qua record cuối cùng của rule engine). */
function markAlerted(rule: string, targetId: string, now: number): void {
  state().lastAlertAt.set(`${rule}:${targetId}`, now)
}

/** Phát cảnh báo: console.warn [OBS-ALERT] + sự kiện obs.alert (tự gate ledger). */
function emitAlert(
  payload: Record<string, unknown>,
  summary: string,
  runId: string | null,
): void {
  console.warn('[OBS-ALERT]', String(payload.rule), JSON.stringify(payload))
  observeEvent({
    actor: 'system:alerts',
    kind: 'obs.alert',
    summary,
    payload,
    ...(runId !== null ? { runId } : {}),
  })
}

// ==================== RULE ENGINE ====================

/** Rule 1 — STALL (D1.1): running run đóng băng > 15 phút, không event 15 phút qua. */
async function checkStallRuns(now: number): Promise<void> {
  try {
    const runs = await db.agentRunRecord.findMany({
      where: { status: 'running' },
      select: { id: true, runId: true, agentName: true, createdAt: true },
      take: SCAN_CAP_RUNS,
    })
    for (const r of runs) {
      // QUYẾT ĐỊNH SCHEMA: AgentRunRecord KHÔNG có updatedAt — mốc hoạt động
      // cuối = createdAt (row 'running' tồn tại từ lúc tracker spawn run)
      const lastActivityMs = r.createdAt.getTime()
      if (!shouldAlertStall(lastActivityMs, now)) continue
      const targetId = r.runId ?? r.id
      if (await isDuplicated('stall', targetId, now)) continue
      // Không có ObservationEvent nào CỦA RUN trong 15 phút qua? — cột runId
      // THẬT (model 103); loại kind obs.alert để không tự-đếm alert của chính
      // rule này; runId null → không gắn kiện được → coi như 0 (chính sự thiếu
      // vết đó là tín hiệu stall)
      if (r.runId) {
        const recent = await db.observationEvent.count({
          where: {
            runId: r.runId,
            ts: { gte: new Date(now - ALERT_STALL_AFTER_MS) },
            kind: { not: 'obs.alert' },
          },
        })
        if (recent > 0) continue // còn hoạt động — không stall
      }
      markAlerted('stall', targetId, now)
      const stalledMinutes = Math.round((now - lastActivityMs) / 60_000)
      emitAlert(
        {
          rule: 'stall',
          targetId,
          runId: r.runId ?? null,
          agentName: r.agentName ?? null,
          stalledMinutes,
          lastActivityAt: new Date(lastActivityMs).toISOString(),
          thresholdMinutes: ALERT_STALL_AFTER_MS / 60_000,
          protocol: 'GIAO_THUC_GIAM_SAT D1.1 (stall ≤ 15 phút)',
        },
        `Run ${r.agentName ?? r.runId ?? r.id.slice(0, 8)} đóng băng ${stalledMinutes} phút — không sự kiện quan sát nào trong 15 phút (D1.1)`,
        r.runId ?? null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule stall thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Rule 2 — TOKEN-BURN (D1.4): run vừa kết thúc tiêu > 500K tokens. */
async function checkTokenBurn(now: number): Promise<void> {
  try {
    // Run "vừa kết thúc" = bản ghi mới trong cửa sổ ~15 phút (AgentRunRecord
    // được ghi LÚC run kết thúc — schema comment dòng ~1185; completedAt chính
    // xác hơn khi có). JS lọc lại bằng shouldAlertTokenBurn sau query.
    const rows = await db.agentRunRecord.findMany({
      where: {
        status: { in: [...ALERT_TERMINAL_STATUSES] },
        createdAt: { gte: new Date(now - ALERT_TOKEN_BURN_WINDOW_MS) },
      },
      select: { id: true, runId: true, agentName: true, status: true, tokensUsed: true, completedAt: true, createdAt: true },
      take: SCAN_CAP_RUNS * 2,
    })
    for (const r of rows) {
      if (typeof r.tokensUsed !== 'number' || !Number.isFinite(r.tokensUsed)) continue
      const endedAtMs = (r.completedAt ?? r.createdAt).getTime()
      if (!shouldAlertTokenBurn(r.tokensUsed, endedAtMs, now)) continue
      const targetId = r.runId ?? r.id
      if (await isDuplicated('token-burn', targetId, now)) continue
      markAlerted('token-burn', targetId, now)
      // Payload đủ số liệu cho post-mortem sau (D1.4: alert + bản ghi phân
      // tích — sự kiện obs.alert chính là bản ghi)
      emitAlert(
        {
          rule: 'token-burn',
          targetId,
          runId: r.runId ?? null,
          agentName: r.agentName ?? null,
          tokensUsed: r.tokensUsed,
          status: r.status ?? null,
          endedAt: new Date(endedAtMs).toISOString(),
          threshold: ALERT_TOKEN_BURN_LIMIT,
          protocol: 'GIAO_THUC_GIAM_SAT D1.4 (token-burn > 500K)',
        },
        `Run ${r.agentName ?? r.runId ?? r.id.slice(0, 8)} (${r.status ?? '?'}) đốt ${(r.tokensUsed / 1000).toFixed(1)}K tokens — vượt ngưỡng 500K (D1.4)`,
        r.runId ?? null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule token-burn thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Rule 3 — JOB HEARTBEAT STALE: (a) BrainSearchRun mồ côi · (b) CronJob quá hạn. */
async function checkJobHeartbeats(now: number): Promise<void> {
  try {
    // (a) BrainSearchRun running mà heartbeatAt cũ hơn 30 phút (§4.2-2b)
    const staleSearch = await db.brainSearchRun.findMany({
      where: { status: 'running', heartbeatAt: { lt: new Date(now - ALERT_HEARTBEAT_STALE_MS) } },
      select: { id: true, brain: true, heartbeatAt: true, startedAt: true },
      take: SCAN_CAP_JOBS,
    })
    for (const s of staleSearch) {
      if (!isHeartbeatStale(s.heartbeatAt.getTime(), now)) continue // double-check pure (where đã lọc)
      const targetId = `brain_search_run:${s.id}`
      if (await isDuplicated('job-stale', targetId, now)) continue
      markAlerted('job-stale', targetId, now)
      const staleMinutes = Math.round((now - s.heartbeatAt.getTime()) / 60_000)
      emitAlert(
        {
          rule: 'job-stale',
          kind: 'brain_search_run',
          targetId,
          rowId: s.id,
          brain: s.brain,
          staleMinutes,
          heartbeatAt: s.heartbeatAt.toISOString(),
          startedAt: s.startedAt.toISOString(),
          thresholdMinutes: ALERT_HEARTBEAT_STALE_MS / 60_000,
          source: 'HyperNAS §4.2-2b — session mồ côi',
        },
        `BrainSearchRun ${s.brain} (session ${s.id.slice(0, 8)}) heartbeat mồ côi ${staleMinutes} phút — worker chết/restart? (§4.2-2b)`,
        null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule job-stale (brain search) thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
  try {
    // (b) CronJob enabled + active mà nextRunAt quá hạn > 60 phút chưa chạy
    const overdue = await db.cronJob.findMany({
      where: {
        enabled: true,
        status: 'active',
        nextRunAt: { lt: new Date(now - ALERT_CRON_OVERDUE_MS) },
      },
      select: { id: true, agentId: true, expression: true, taskPrompt: true, nextRunAt: true, lastRunAt: true },
      take: SCAN_CAP_JOBS,
    })
    for (const j of overdue) {
      const nextMs = j.nextRunAt ? j.nextRunAt.getTime() : null
      if (!shouldAlertCronOverdue(nextMs, now)) continue
      const targetId = `cron_job:${j.id}`
      if (await isDuplicated('job-stale', targetId, now)) continue
      markAlerted('job-stale', targetId, now)
      const overdueMinutes = Math.round((now - (nextMs as number)) / 60_000)
      emitAlert(
        {
          rule: 'job-stale',
          kind: 'cron_job',
          targetId,
          rowId: j.id,
          agentId: j.agentId,
          expression: j.expression,
          taskPrompt: j.taskPrompt.slice(0, 120),
          overdueMinutes,
          nextRunAt: (j.nextRunAt as Date).toISOString(),
          lastRunAt: j.lastRunAt ? j.lastRunAt.toISOString() : null,
          thresholdMinutes: ALERT_CRON_OVERDUE_MS / 60_000,
        },
        `CronJob ${j.expression} (agent ${j.agentId}) quá hạn ${overdueMinutes} phút chưa chạy (ngưỡng 60 phút)`,
        null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule job-stale (cron) thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== RULE 4 — ORPHAN SWEEP (Task 32 — D1.2 enabler) ====================

/**
 * DỌN RUN MỒ CÔI GIỮA PHIÊN — con mắt thứ 4 của giao thức quan sát.
 *
 * Boot sweeper (instrumentation-node.ts) chỉ chạy lúc KHỞI ĐỘNG; run chết
 * giữa chừng trong CÙNG process (chat abort, exception trước endAgentRun,
 * persist AgentRunRecord fail) → DB row kẹt 'running' MÃI TỚI RESTART —
 * bằng chứng 2026-10-13: MEGATRON 17:01:34 + Omega 16:26:56 kẹt 'running'
 * ~50-90 phút dù run thật đã chết, rule stall phát alert đúng nhưng KHÔNG ai
 * đóng sổ → D1.2 ("0 job kẹt quá hạn") fail vĩnh viễn + số liệu vận hành bị
 * nhiễu (bất cứ query nào đếm 'running' đều sai).
 *
 * An toàn 2 lớp: (1) isRunIdActiveInMemory — run còn sống trong process này
 * (goal-loop đang chạy / LLM call dài) → BỎ QUA; (2) tuổi > 30 phút. Run của
 * process trước rơi vào boot sweeper — đây chỉ lo mồ côi giữa phiên.
 * Hành động: update status='failed', stopReason='crashed' + obs.alert rule
 * orphan-sweep (Đài quan sát thấy việc dọn + lý do). Fail-open tuyệt đối.
 */
async function sweepOrphanedRuns(now: number): Promise<void> {
  try {
    const stale = await db.agentRunRecord.findMany({
      where: { status: 'running', createdAt: { lt: new Date(now - ALERT_ORPHAN_AFTER_MS) } },
      select: { id: true, runId: true, agentName: true, createdAt: true, sessionId: true },
      take: SCAN_CAP_RUNS,
    })
    if (stale.length === 0) return
    // Dynamic import — tiền lệ ledger note ở tracker (chống chu trình tĩnh:
    // tracker dynamic-import ledger, ledger KHÔNG import tracker)
    const { isRunIdActiveInMemory } = await import('@/lib/agent-run-tracker')
    let swept = 0
    for (const r of stale) {
      if (isRunIdActiveInMemory(r.runId)) continue // còn sống thật — không đụng
      try {
        await db.agentRunRecord.update({
          where: { id: r.id },
          data: { status: 'failed', stopReason: 'crashed', completedAt: new Date() },
        })
        swept++
        const orphanMinutes = Math.round((now - r.createdAt.getTime()) / 60_000)
        emitAlert(
          {
            rule: 'orphan-sweep',
            targetId: r.runId ?? r.id,
            runId: r.runId ?? null,
            agentName: r.agentName ?? null,
            sessionId: r.sessionId,
            orphanMinutes,
            startedAt: r.createdAt.toISOString(),
            thresholdMinutes: ALERT_ORPHAN_AFTER_MS / 60_000,
            action: 'AgentRunRecord → failed/crashed (đóng sổ mồ côi giữa phiên)',
            protocol: 'GIAO_THUC_GIAM_SAT D1.2 (0 run kẹt quá hạn)',
          },
          `Dọn run mồ côi ${r.agentName ?? r.runId ?? r.id.slice(0, 8)} — kẹt 'running' ${orphanMinutes} phút (đã chết giữa chừng, bộ nhớ không còn run này) → đánh dấu failed/crashed`,
          r.runId ?? null,
        )
      } catch {
        // fail-open từng row — row khác vẫn được quét
      }
    }
    if (swept > 0) {
      console.warn(`[OBS-ALERT] orphan-sweep: đóng sổ ${swept} run mồ côi (status 'running' > ${ALERT_ORPHAN_AFTER_MS / 60_000} phút, không còn sống trong bộ nhớ) → failed/crashed`)
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule orphan-sweep thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== ENTRY (gọi từ tick impact.ts) ====================

/**
 * Chạy toàn bộ 4 rule (3 cảnh báo + 1 dọn mồ côi) — gọi từ tick worker impact.ts
 * mỗi 10 phút.
 * Cờ obs_alerts off → return NGAY (rẻ). Cờ obs_ledger off → console.warn vẫn
 * phát; sự kiện obs.alert tự no-op ở ledger (xem header). Fail-open tuyệt
 * đối: KHÔNG throw, KHÔNG log spam (tối đa 1 dòng console.error mỗi rule khi
 * rule đó lỗi).
 */
export async function runAlertChecks(): Promise<void> {
  try {
    if (!isObsAlertsEnabled()) return // cờ off → rỗng (check MỖI vòng — hiệu lực ngay)
    const now = Date.now()
    await checkStallRuns(now)
    await checkTokenBurn(now)
    await checkJobHeartbeats(now)
    // Task 32 — chạy SAU stall rule: stall alert (D1.1) phát hiện TRƯỚC cho
    // operator thấy, sweep đóng sổ (D1.2) SAU — đúng trình tự "phát hiện rồi xử lý".
    await sweepOrphanedRuns(now)
    // alert vừa phát là fire-and-forget — flush để dedup query của TICK SAU
    // (và test) thấy ngay (an toàn: flush fail-open nội bộ ledger)
    await flushObservationQueue().catch(() => {})
  } catch (err) {
    console.error('[OBS-ALERT] runAlertChecks thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}
