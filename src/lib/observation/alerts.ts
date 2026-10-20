/**
 * GAP-2 (Task 26-BE — GIAO_THUC_GIAM_SAT_AGENTS.md D1.1/D1.4 +
 * BLUEPRINT-HYPERNAS-P1-P5 §4.2-2b) — CẢNH BÁO CHỦ ĐỘNG
 * ==========================================================================
 *
 * `runAlertChecks()` — 11 rule (thế hệ 1: 4 cảnh báo + 1 dọn mồ côi Task 32
 * + 1 repair R4; thế hệ 2 OBS-P6 R34: evo-stuck + eval-starvation +
 * train-gate-repeat + provider-degraded + evo-budget-burn) chạy trong tick
 * 10 phút của worker impact.ts (CÙNG setInterval — KHÔNG timer mới; gọi NGAY
 * SAU pass impact; static import an toàn vì alerts KHÔNG import ngược impact):
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
 *      giữa phiên — boot sweeper chỉ lo lúc khởi động. R4-ĐIỀU TRA: sweep giờ
 *      SALVAGE metadata (complete=false + duration + checkpoint tokens —
 *      nhãn tiêu cực cho Brain-B) + viết CHAT TRACE vào phiên (user không
 *      còn mất dấu vết tác vụ) + resolve verdict/Q-learn mirror goal-loop.
 *   5. BRAIN-LABEL-STARVATION (R4-ĐIỀU TRA): "não chết đói nhãn" — (a) eval
 *      case có sẵn mà không ai chạy eval (Brain-A ngủ mãi), (b) run kết thúc
 *      mà không chốt metadata (xưởng nhãn Brain-B rò rỉ). Đây chính là lớp
 *      giao thức quan sát TỪNG BỎ SÓT (user R4: "tại sao không thấy Brain-A
 *      không tiến triển qua nhiều lượt").
 *   6. CHAT-TRACE-LOSS (R4-ĐIỀU TRA — TỰ REPAIR): chatMessage mồ côi (session
 *      row bị mất do crash giữa early-save và upsert) → tạo lại AgentSession
 *      row — tin nhắn HIỆN LẠI trong khung chat (user R4: "quay lại không
 *      còn thấy gì nữa, không có dấu vết").
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
 * isHeartbeatStale/shouldAlertCronOverdue + thế hệ 2: shouldAlertEvoStuck/
 * shouldAlertEvalStarvation/shouldAlertTrainGateRepeat/
 * shouldAlertProviderDegraded/shouldAlertEvoBudgetBurn) — rule engine chỉ lo
 * query + IO; test r99/r122 pin biên trực tiếp. Mọi DB op try/catch —
 * worker KHÔNG throw.
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
      // Task 33 (§0b lượt 2): stalledMinutes = độ stale THẬT (mốc sự kiện
      // cuối của run, có run.heart nuôi), KHÔNG phải tuổi run — bản cũ in
      // "đóng băng 38 phút" cho run 38 phút tuổi dù hoạt động cuối chỉ cách
      // 16 phút (đo thật 18:40:40) — chẩn đoán sai mức độ.
      let stalledMinutes = Math.round((now - lastActivityMs) / 60_000)
      if (r.runId) {
        try {
          const lastEvt = await db.observationEvent.findFirst({
            where: { runId: r.runId },
            orderBy: { ts: 'desc' },
            select: { ts: true },
          })
          if (lastEvt?.ts) stalledMinutes = Math.round((now - lastEvt.ts.getTime()) / 60_000)
        } catch {
          /* fail-open — giữ mốc createdAt */
        }
      }
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
    // Run "vừa kết thúc" — Task 33 (§0b lượt 2) FIX CỬA SỔ: bản cũ lọc
    // createdAt ≥ now−15' theo assumption "row được ghi LÚC KẾT THÚC" —
    // SAI với kiến trúc hiện tại (insertAgentRunRecordRunning insert row
    // 'running' NGAY LÚC BẮT ĐẦU): run dài > 15' rơi hết cửa sổ → alert
    // D1.4 MISSED hoàn toàn (đo thật: Omega 1.681.651 token · 42 phút ·
    // cancelled 18:44:45 — tick 18:50:40 im lặng vì createdAt 18:02:48).
    // Cửa sổ đúng = mốc KẾT THÚC (completedAt); nhánh fallback giữ hành vi
    // cũ cho row completedAt null (code cũ/kẹt — endedAt=createdAt trong JS).
    const windowStart = new Date(now - ALERT_TOKEN_BURN_WINDOW_MS)
    const rows = await db.agentRunRecord.findMany({
      where: {
        status: { in: [...ALERT_TERMINAL_STATUSES] },
        OR: [
          { completedAt: { gte: windowStart } },
          { completedAt: null, createdAt: { gte: windowStart } },
        ],
      },
      select: { id: true, runId: true, agentName: true, status: true, tokensUsed: true, completedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
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
      select: {
        id: true, runId: true, agentName: true, createdAt: true, sessionId: true, model: true,
        // R4-ĐIỀU TRA — salvage: đọc metadata đã checkpoint giữa chừng (FIX-A)
        cycles: true, tokensUsed: true, durationMs: true, toolCalls: true, toolFailures: true,
      },
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
        await salvageCrashedRun(r, now)
        swept++
      } catch {
        // fail-open từng row — row khác vẫn được quét
      }
    }
    if (swept > 0) {
      console.warn(`[OBS-ALERT] orphan-sweep: đóng sổ ${swept} run mồ côi (status 'running' > ${ALERT_ORPHAN_AFTER_MS / 60_000} phút, không còn sống trong bộ nhớ) → failed/crashed + salvage + chat trace`)
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule orphan-sweep thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== R4 — SALVAGE 1 RUN CHẾT GIỮA CHỪNG (export cho boot sweeper) ====================

/** Shape tối thiểu salvageCrashedRun cần từ 1 row AgentRunRecord 'running' đã chết. */
export interface SalvageRunRow {
  id: string
  runId: string | null
  agentName: string | null
  createdAt: Date
  sessionId: string | null
  model?: string | null
  cycles?: number | null
  tokensUsed?: number | null
  durationMs?: number | null
  toolCalls?: number | null
  toolFailures?: number | null
}

/**
 * R4-ĐIỀU TRA (lượt 4) — SALVAGE trọn vẹn 1 run chết giữa chừng (dùng chung:
 * runtime orphan-sweep + boot sweeper instrumentation-node):
 *   (1) UPDATE row: failed/crashed + complete=false (SỰ THẬT — run không xong)
 *       + durationMs (checkpoint có thì giữ, thiếu → ước lượng startedAt→now)
 *       — row thành nhãn usable (kết cục tiêu cực) cho Brain-B "Vọng";
 *   (2) CHAT TRACE: assistant message vào session (tombstone-guard, idempotent
 *       theo runId) — user luôn thấy dấu vết "tác vụ bị gián đoạn";
 *   (3) VERDICT RESOLVE + Q-LEARN mirror goal-loop close (P6-M2).
 * Mỗi bước fail-open riêng — salvage không được phép throw.
 */
export async function salvageCrashedRun(r: SalvageRunRow, now: number): Promise<void> {
  // (1) UPDATE row + salvage metadata (dedup alert 1h — boot sweep + runtime
  // sweep có thể cùng bắt 1 run trong cửa sổ restart: chỉ alert lần đầu)
  try {
    const durationMs =
      typeof r.durationMs === 'number' && r.durationMs > 0
        ? r.durationMs
        : Math.max(0, now - r.createdAt.getTime())
    const targetId = r.runId ?? r.id
    const alreadyAlerted = await isDuplicated('orphan-sweep', targetId, now)
    await db.agentRunRecord.update({
      where: { id: r.id },
      data: {
        status: 'failed',
        stopReason: 'crashed',
        completedAt: new Date(),
        complete: false,
        durationMs,
      },
    })
    const orphanMinutes = Math.round((now - r.createdAt.getTime()) / 60_000)
    if (!alreadyAlerted) {
      markAlerted('orphan-sweep', targetId, now)
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
        salvaged: {
          complete: false,
          cycles: r.cycles ?? null,
          tokensUsed: r.tokensUsed ?? null,
          durationMs,
        },
        action: 'AgentRunRecord → failed/crashed + salvage metadata (complete=false, duration, checkpoint tokens) — nhãn tiêu cực cho Brain-B',
        protocol: 'GIAO_THUC_GIAM_SAT D1.2 (0 run kẹt quá hạn) + R4 salvage',
      },
      `Dọn run mồ côi ${r.agentName ?? r.runId ?? r.id.slice(0, 8)} — kẹt 'running' ${orphanMinutes} phút (đã chết giữa chừng) → đánh dấu failed/crashed + salvage ${r.tokensUsed != null ? `${r.tokensUsed} tokens/${r.cycles ?? '?'} chu kỳ checkpoint` : 'metadata tiêu cực'}`,
      r.runId ?? null,
      )
      // R17 (QUAN-SAT lượt 7 · 6.1a) — ĐƯỜNG GHI NỢ THỨ 4 "crash-proof":
      // sự cố chính là nguồn nợ đáng tin nhất — ghi TẠI NƠI PHÁT HIỆN (ngay khi
      // salvage đóng sổ run crashed), KHÔNG đợi arbiter/finalize. Bằng chứng
      // R16 V2: 3 đường ghi cũ đều qua arbiter/finalize → run crash (process
      // chết) không bao giờ tới vòng tổng kết → DebtLedger trắng sau 24h có
      // 3 run failed/crashed. kind='infra' (severity high — agent không tự
      // phục vụ được); dedupe do recordDebtIssue upsert theo fingerprint
      // xuyên run; cửa !alreadyAlerted chống boot sweep + runtime sweep đếm
      // trùng 1 run (2 salvage cùng runId chỉ ghi nợ 1 lần). Fail-open.
      try {
        const { recordDebtIssue } = await import('@/lib/execution/debt-ledger')
        await recordDebtIssue({
          issue: `Run ${r.agentName ?? r.runId ?? r.id.slice(0, 8)} crashed (salvage) — process chết giữa chừng, không finalize được (mồ côi ${orphanMinutes} phút)`,
          kind: 'infra',
          sessionId: r.sessionId,
          runId: r.runId,
          evidence: `salvage row ${r.id}: complete=false · durationMs=${durationMs} · checkpoint ${r.cycles ?? '?'} chu kỳ ~${r.tokensUsed ?? '?'} tokens · toolCalls=${r.toolCalls ?? '?'}`,
        })
      } catch { /* fail-open — ghi nợ không được phép làm hỏng salvage */ }
    }
  } catch {
    /* fail-open bước 1 */
  }
  // (2) CHAT TRACE — user report: "thấy agent đang xử lý, quay lại không còn
  // thấy gì nữa". Fire-and-forget, fail-open.
  if (r.sessionId) {
    await writeCrashedRunChatTrace(r.sessionId, {
      runId: r.runId ?? r.id,
      agentName: r.agentName ?? null,
      orphanMinutes: Math.round((now - r.createdAt.getTime()) / 60_000),
      cycles: r.cycles ?? null,
      tokensUsed: r.tokensUsed ?? null,
    }).catch(() => { /* fail-open */ })
  }
  // (3) VERDICT RESOLVE + Q-LEARN (mirror goal-loop close) — fire-and-forget.
  if (r.sessionId) {
    await resolveVerdictsAndQLearnForCrashedRun(r.sessionId, r.model ?? null).catch(() => { /* fail-open */ })
  }
}

// ==================== R4 HELPERS — chat trace + verdict/Q cho run chết ====================

/**
 * R4-ĐIỀU TRA — viết assistant ChatMessage thông báo run bị gián đoạn, kèm
 * metadata agentRun để UI render link/panel. Chỉ khi session chưa bị user
 * xóa (tombstone deep check). Đảm bảo session row tồn tại (upsert create-if-
 * missing — chống message mồ côi vô hình). Idempotent theo metadata.runId:
 * không viết trùng khi sweep chạy lại.
 */
async function writeCrashedRunChatTrace(
  sessionId: string,
  info: { runId: string; agentName: string | null; orphanMinutes: number; cycles: number | null; tokensUsed: number | null },
): Promise<void> {
  try {
    const { isSessionDeletedDeep } = await import('@/lib/session-tombstone')
    if (await isSessionDeletedDeep(sessionId)) return
    // Đã có trace cho run này chưa? (sweep chạy lại / boot sweep + runtime
    // sweep cùng bắt 1 run) — metadataJson LIKE chạy trên index sessionId.
    const dup = await db.chatMessage.findFirst({
      where: { sessionId, role: 'assistant', metadata: { contains: `"runId":"${info.runId}"` } },
      select: { id: true },
    })
    if (dup) return
    await ensureSessionRow(sessionId, null)
    const cyclesTxt = info.cycles != null ? ` ở chu kỳ ${info.cycles}` : ''
    const tokensTxt = info.tokensUsed != null ? ` · đã dùng ~${info.tokensUsed.toLocaleString('vi-VN')} tokens` : ''
    await db.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: `⚠️ **Tác vụ bị gián đoạn** — run \`${info.runId}\` của ${info.agentName ?? 'agent'} dừng bất thường (app restart / thiếu bộ nhớ) sau ${info.orphanMinutes} phút${cyclesTxt}${tokensTxt}. Tiến độ đã được lưu vào bộ nhớ hệ thống (agent-run + episodic). Bạn có thể gửi lại yêu cầu để agent tiếp tục — nó sẽ thấy bài học từ lần chạy này.`,
        model: null,
        provider: 'system',
        metadata: JSON.stringify({
          interrupted: true,
          agentRun: { runId: info.runId, status: 'failed', stopReason: 'crashed' },
          runId: info.runId,
          salvaged: { cycles: info.cycles, tokensUsed: info.tokensUsed },
        }),
      },
    })
  } catch {
    /* fail-open — trace không được phép làm hỏng sweep */
  }
}

/**
 * R4-ĐIỀU TRA — đảm bảo AgentSession row tồn tại cho sessionId (create-if-
 * missing; bỏ qua tombstone). Dùng cho sweep trace + rule 6 repair: message/
 * run mà session row bị mất (OOM giết request giữa early-save và upsert)
 * sẽ HIỆN LẠI trong danh sách phiên của UI.
 */
async function ensureSessionRow(sessionId: string, agentProfileId: string | null): Promise<boolean> {
  try {
    const existing = await db.agentSession.findUnique({ where: { sessionId }, select: { sessionId: true } })
    if (existing) return true
    const { isSessionDeletedDeep } = await import('@/lib/session-tombstone')
    if (await isSessionDeletedDeep(sessionId)) return false
    const firstMsg = await db.chatMessage.findFirst({
      where: { sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { content: true, createdAt: true },
    })
    const msgCount = await db.chatMessage.count({ where: { sessionId } })
    await db.agentSession.create({
      data: {
        sessionId,
        agentId: 'default',
        title: (firstMsg?.content ?? 'Phiên đã khôi phục').slice(0, 50),
        messageCount: msgCount,
        agentProfileId,
        ...(firstMsg ? { createdAt: firstMsg.createdAt, updatedAt: firstMsg.createdAt } : {}),
      },
    })
    return true
  } catch {
    return false // đã tồn tại (race) hoặc DB lỗi — fail-open
  }
}

/**
 * R4-ĐIỀU TRA — mirror goal-loop close cho run chết: resolve verdicts treo
 * theo runComplete=false + updateQ reward cùng công thức P6-M2. Chỉ chạy khi
 * session KHÔNG còn run 'running' nào (verdict resolve theo sessionId —
 * không chộp của run khác). Fire-and-forget từ sweep.
 */
async function resolveVerdictsAndQLearnForCrashedRun(sessionId: string, model: string | null): Promise<void> {
  try {
    const stillRunning = await db.agentRunRecord.findFirst({
      where: { sessionId, status: 'running' },
      select: { id: true },
    })
    if (stillRunning) return
    const { resolveArbiterVerdictsDetailed } = await import('@/lib/metrics-db')
    const { total, confirmed, refuted } = await resolveArbiterVerdictsDetailed(sessionId, false, 'crashed')
    if (total === 0) return
    // P6-M2: runComplete=false → confirmed KHÔNG cộng (+1 cần complete) — chỉ
    // refuted mới trừ (verdict nói việc bị bác).
    const reward = refuted > 0 ? -1 : 0
    if (reward === 0) return
    if (!model) return
    const { updateQ, agentRuntimeStateKey } = await import('@/lib/learning/q-table')
    const stateKey = agentRuntimeStateKey()
    await updateQ(stateKey, model, reward, stateKey)
    console.log(`[OBS-ALERT] salvage Q-learn (${sessionId.slice(0, 18)}): ${model} reward=${reward} (${confirmed}✓/${refuted}✗ từ run crashed)`)
  } catch {
    /* fail-open */
  }
}

// ==================== RULE 5 (R4) — BRAIN-LABEL-STARVATION ====================

/**
 * R4-ĐIỀU TRA — "não chết đói nhãn" là lớp cảnh báo GIAO THỨC QUAN SÁT còn
 * thiếu (user: "tại sao kích hoạt giao thức quan sát lại không thấy Brain-A
 * không tiến triển"). 2 nhánh:
 *   (a) Xưởng nhãn eval im lặng: EvalCase active > 0 nhưng EvalResult < 30
 *       (ngưỡng thức tỉnh Brain-A) và không có EvalRun trong 24h → nhắc chạy
 *       eval (auto-eval sẽ tự xử khi cờ auto_eval_kb bật).
 *   (b) Run-close gap: ≥ 5 run kết thúc (terminal) trong 24h mà ≥ 50% không
 *       chốt metadata (complete=null) → xưởng nhãn Brain-B rò rỉ (run chết
 *       không salvage được — vd chết TRƯỚC checkpoint đầu tiên).
 * Dedup 1h/(rule,targetId='brains') như mọi rule. Alert ONE-SHOT tổng hợp —
 * không spam từng nhãn.
 */
async function checkBrainLabelStarvation(now: number): Promise<void> {
  try {
    const targetId = 'brains'
    if (await isDuplicated('brain-label-starvation', targetId, now)) return
    const dayAgo = new Date(now - 24 * 60 * 60_000)

    const [activeCases, evalResults, recentEvalRun, terminalRuns, unfinalized] = await Promise.all([
      db.evalCase.count({ where: { active: true } }),
      db.evalResult.count(),
      db.evalRun.findFirst({ where: { startedAt: { gte: dayAgo } }, select: { id: true } }),
      db.agentRunRecord.count({
        where: { status: { in: [...ALERT_TERMINAL_STATUSES] }, createdAt: { gte: dayAgo } },
      }),
      db.agentRunRecord.count({
        where: {
          status: { in: [...ALERT_TERMINAL_STATUSES] },
          createdAt: { gte: dayAgo },
          complete: null,
        },
      }),
    ])

    let summary: string | null = null
    const payload: Record<string, unknown> = {
      rule: 'brain-label-starvation',
      targetId,
      evalCases: activeCases,
      evalResults,
      terminalRuns24h: terminalRuns,
      unfinalized24h: unfinalized,
      brainAmin: 30,
      brainBmin: 60,
      protocol: 'R4-ĐIỀU TRA — não chết đói nhãn (giao thức quan sát lượt 4)',
    }

    if (activeCases > 0 && evalResults < 30 && !recentEvalRun) {
      summary = `Não chết đói nhãn (A): ${activeCases} eval case sẵn sàng nhưng chỉ ${evalResults}/30 nhãn EvalResult và không có eval nào chạy trong 24h — Brain-A "V3" không bao giờ thức tỉnh nếu không chạy eval (auto_eval_kb sẽ tự bắn nếu bật)`
    } else if (terminalRuns >= 5 && unfinalized / terminalRuns >= 0.5) {
      summary = `Não chết đói nhãn (B): ${unfinalized}/${terminalRuns} run kết thúc 24h qua KHÔNG chốt metadata (complete=null) — run chết trước checkpoint đầu tiên, xưởng nhãn Brain-B "Vọng" (${Math.max(0, terminalRuns - unfinalized)} usable) đang rò rỉ dữ liệu train`
    }
    if (!summary) return

    markAlerted('brain-label-starvation', targetId, now)
    emitAlert(payload, summary, null)
  } catch (err) {
    console.error('[OBS-ALERT] rule brain-label-starvation thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== RULE 6 (R4) — CHAT-TRACE-LOSS (repair) ====================

/**
 * R4-ĐIỀU TRA — user report: "tác vụ không hề được lưu lại hiển thị trong
 * khung chat... quay lại không còn thấy gì nữa, không có dấu vết". Bằng
 * chứng đo thật: session sess_1791918531965 bị MẤT row AgentSession (OOM
 * giết request giữa early-save user message và agentSession.upsert) → user
 * message mồ côi VÔ HÌNH (danh sách phiên đọc từ AgentSession). Rule quét
 * chatMessage có sessionId không tồn tại trong AgentSession (bỏ tombstone —
 * session do user chủ động xóa) → TỰ REPAIR (tạo lại row session, title từ
 * message đầu) + obs.alert báo việc phục hồi. Cap 20 phiên/lần.
 */
async function checkChatTraceLoss(now: number): Promise<void> {
  try {
    const targetId = 'chat-trace'
    if (await isDuplicated('chat-trace-loss', targetId, now)) return
    // GroupBy sessionId trên chatMessage — cap quét 500 message gần nhất
    const grouped = await db.chatMessage.groupBy({
      by: ['sessionId'],
      _count: true,
      orderBy: { sessionId: 'asc' },
      take: 50,
    })
    if (grouped.length === 0) return
    const sessionIds = grouped.map(g => g.sessionId)
    const existing = await db.agentSession.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true },
    })
    const existingSet = new Set(existing.map(e => e.sessionId))
    const orphans = grouped.filter(g => !existingSet.has(g.sessionId))
    if (orphans.length === 0) return

    // Repair từng phiên mồ côi — infer agentProfileId từ run gần nhất của phiên
    let repaired = 0
    const repairedIds: string[] = []
    for (const o of orphans.slice(0, 20)) {
      const run = await db.agentRunRecord.findFirst({
        where: { sessionId: o.sessionId },
        orderBy: { startedAt: 'desc' },
        select: { agentId: true },
      })
      const ok = await ensureSessionRow(o.sessionId, run?.agentId ?? null)
      if (ok) {
        repaired++
        repairedIds.push(o.sessionId)
      }
    }
    if (repaired > 0) {
      markAlerted('chat-trace-loss', targetId, now)
      emitAlert(
        {
          rule: 'chat-trace-loss',
          targetId,
          orphanSessions: orphans.length,
          repaired,
          repairedIds,
          action: 'Tự tạo lại AgentSession row cho phiên mồ côi — tin nhắn HIỆN LẠI trong khung chat',
          protocol: 'R4-ĐIỀU TRA — chat trace loss repair (giao thức quan sát lượt 4)',
        },
        `Phục hồi ${repaired}/${orphans.length} phiên chat mất dấu vết (row AgentSession bị mất do crash giữa chừng — message vẫn nằm trong DB) — tin nhắn đã hiện lại trong danh sách phiên`,
        null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule chat-trace-loss thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== ENTRY (gọi từ tick impact.ts) ====================

/**
 * Chạy toàn bộ 11 rule (thế hệ 1: 4 cảnh báo + 1 dọn mồ côi + 1 repair; thế
 * hệ 2 OBS-P6 R34: 5 rule evo-stuck/eval-starvation/train-gate-repeat/
 * provider-degraded/evo-budget-burn) — gọi từ tick worker impact.ts mỗi
 * 10 phút.
 * Cờ obs_alerts off → return NGAY (rẻ). Cờ obs_ledger off → console.warn vẫn
 * phát; sự kiện obs.alert tự no-op ở ledger (xem header). Fail-open tuyệt
 * đối: KHÔNG throw, KHÔNG log spam (tối đa 1 dòng console.error mỗi rule khi
 * rule đó lỗi).
 */
// ============================================================================
// OBS-P6 (BLUEPRINT-OBSERVATION-V3 §C.2 — R34) — ALERT THẾ HỆ 2
// 5 rule cho failure mode của kiến trúc 4 não + NAS/EVO + eval + provider.
// Cùng pattern rule thế hệ 1: fail-open + dedupe 2 lớp (rule, targetId)/1h +
// phần quyết định tách PURE để test pin biên (r122).
// ============================================================================

/** EVO worker kẹt/chết khi heartbeat stale > 5 phút (candidate train thật
 * < 60s — Q2 per-candidate budget; job-stale thế hệ 1 giữ backstop 30 phút). */
export const ALERT_EVO_STUCK_AFTER_MS = 5 * 60_000
/** train-gate-repeat: ≥ 3 lần train blocked / não / 24h. */
export const ALERT_TRAIN_GATE_LIMIT = 3
export const ALERT_TRAIN_GATE_WINDOW_MS = 24 * 3600_000
/** provider-degraded: cùng (provider, model) fail ≥ 3 lần / 1h. */
export const ALERT_PROVIDER_DEGRADED_LIMIT = 3
export const ALERT_PROVIDER_DEGRADED_WINDOW_MS = 60 * 60_000

/** FB-OBSV3-R1-09.3 (R35 fixbug): cửa sổ evo-budget-burn TÁCH hằng riêng —
 * trước R35 mượn ALERT_TRAIN_GATE_WINDOW_MS nên ai tinh chỉnh cửa sổ
 * train-gate vô tình đổi cửa sổ budget-burn (coupling ngữ nghĩa không lý do). */
export const ALERT_EVO_BUDGET_WINDOW_MS = 24 * 3600_000
/** evo-budget-burn: nAbandoned ≥ 3 VÀ > 50% candidatesMax. */
export const ALERT_EVO_BURN_MIN_ABANDONED = 3
export const ALERT_EVO_BURN_RATIO = 0.5

// ---------- PURE (test r122 pin biên — strict như thế hệ 1) ----------

/** EVO stuck khi heartbeat cũ HƠN 5 phút (strict: đúng 5 phút chưa là stuck). */
export function shouldAlertEvoStuck(heartbeatAtMs: number, now: number): boolean {
  return now - heartbeatAtMs > ALERT_EVO_STUCK_AFTER_MS
}

export interface EvalRunLite { caseCount: number; refusalCount: number }

/**
 * Eval starvation khi 2 run completed GẦN NHẤT (mới nhất đầu) ĐỀU 100%
 * refusal (refusalCount ≥ caseCount > 0) — não không thể thức tỉnh vì không
 * bao giờ có nhãn positive (tiền lệ R33: 36/36 refusal → train gate class
 * imbalance Positive=0/44).
 */
export function shouldAlertEvalStarvation(recentCompleted: EvalRunLite[]): boolean {
  if (recentCompleted.length < 2) return false
  const [a, b] = recentCompleted
  return a.caseCount > 0 && b.caseCount > 0
    && a.refusalCount >= a.caseCount
    && b.refusalCount >= b.caseCount
}

/** Train-gate-repeat khi số lần train blocked (trained=false) ≥ 3 (strict). */
export function shouldAlertTrainGateRepeat(blockedCount: number): boolean {
  return blockedCount >= ALERT_TRAIN_GATE_LIMIT
}

/** Provider-degraded khi cùng (provider, model) fail ≥ 3 lần trong 1h. */
export function shouldAlertProviderDegraded(failCount: number): boolean {
  return failCount >= ALERT_PROVIDER_DEGRADED_LIMIT
}

/** Evo-budget-burn khi nAbandoned ≥ 3 VÀ tỉ lệ bỏ > 50% (strict >, không ≥). */
export function shouldAlertEvoBudgetBurn(nAbandoned: number, candidatesMax: number): boolean {
  return candidatesMax > 0
    && nAbandoned >= ALERT_EVO_BURN_MIN_ABANDONED
    && (nAbandoned / candidatesMax) > ALERT_EVO_BURN_RATIO
}

// ---------- RULE ENGINE (query + emit; mọi DB op try/catch) ----------

/** Rule 8 — EVO-STUCK: BrainSearchRun running mà heartbeat stale > 5 phút
 * (không cần ai mở tab Tiến hoá — GET sweep 60s chỉ chạy khi có người nhìn). */
async function checkEvoStuck(now: number): Promise<void> {
  try {
    const stuck = await db.brainSearchRun.findMany({
      where: { status: 'running', heartbeatAt: { lt: new Date(now - ALERT_EVO_STUCK_AFTER_MS) } },
      select: { id: true, brain: true, heartbeatAt: true, startedAt: true, candidatesMax: true },
      take: SCAN_CAP_JOBS,
    })
    for (const s of stuck) {
      if (!shouldAlertEvoStuck(s.heartbeatAt.getTime(), now)) continue
      const targetId = `brain_search_run:${s.id}`
      if (await isDuplicated('evo-stuck', targetId, now)) continue
      markAlerted('evo-stuck', targetId, now)
      const staleMinutes = Math.round((now - s.heartbeatAt.getTime()) / 60_000)
      emitAlert(
        {
          rule: 'evo-stuck',
          kind: 'brain_search_run',
          targetId,
          rowId: s.id,
          brain: s.brain,
          staleMinutes,
          heartbeatAt: s.heartbeatAt.toISOString(),
          startedAt: s.startedAt.toISOString(),
          thresholdMinutes: ALERT_EVO_STUCK_AFTER_MS / 60_000,
          source: 'OBS-P6 (BLUEPRINT-OBSERVATION-V3 §C.2) — EVO worker chết/kẹt, chưa ai poll GET để sweep',
        },
        `EVO ${s.brain} (session ${s.id.slice(0, 8)}) heartbeat stale ${staleMinutes} phút — worker chết/kẹt giữa ứng viên (nobody polled — GET sweep chưa chạy)`,
        null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule evo-stuck thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Rule 9 — EVAL-STARVATION: 2 run completed gần nhất đều 100% refusal —
 * xưởng nhãn chết đói nhãn positive, não A/D không bao giờ thức tỉnh được. */
async function checkEvalStarvation(now: number): Promise<void> {
  try {
    const runs = await db.evalRun.findMany({
      where: { status: 'completed' },
      orderBy: { startedAt: 'desc' },
      take: 2, // FB-OBSV3-R1-09.1: đúng "2 run gần nhất" — pure chỉ dùng 2
      select: { id: true, caseCount: true, refusalCount: true, answeredCount: true, startedAt: true },
    })
    if (runs.length < 2) return
    const lite: EvalRunLite[] = runs.map(r => ({ caseCount: r.caseCount, refusalCount: r.refusalCount }))
    if (!shouldAlertEvalStarvation(lite)) return
    const targetId = `eval:starvation`
    if (await isDuplicated('eval-starvation', targetId, now)) return
    markAlerted('eval-starvation', targetId, now)
    emitAlert(
      {
        rule: 'eval-starvation',
        kind: 'eval_runs',
        targetId,
        runs: runs.slice(0, 2).map(r => ({
          runId: r.id,
          caseCount: r.caseCount,
          refusalCount: r.refusalCount,
          answeredCount: r.answeredCount,
          startedAt: r.startedAt.toISOString(),
        })),
        source: 'OBS-P6 §C.2 — 2 eval run gần nhất 100% refusal → không nhãn positive → train gate class imbalance (tiền lệ R33: 36/36, Positive=0/44)',
      },
      `Eval toàn refusal 2 run liên tiếp (${runs[0].refusalCount}/${runs[0].caseCount} + ${runs[1].refusalCount}/${runs[1].caseCount}) — não không thể thức tỉnh: xem retrieval/Qdrant thay vì chạy eval tiếp`,
      null,
    )
  } catch (err) {
    console.error('[OBS-ALERT] rule eval-starvation thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Rule 10 — TRAIN-GATE-REPEAT: brain.train end trained=false ≥ 3 lần /
 * não / 24h — đốt compute thử train mà gate luôn chặn (thiếu dữ liệu/lệch lớp). */
async function checkTrainGateRepeat(now: number): Promise<void> {
  try {
    const events = await db.observationEvent.findMany({
      where: { kind: 'brain.train', ts: { gte: new Date(now - ALERT_TRAIN_GATE_WINDOW_MS) } },
      orderBy: { ts: 'desc' },
      select: { payloadJson: true, ts: true },
      take: 400,
    })
    const blockedByBrain = new Map<string, { count: number; latestError: string | null }>()
    for (const e of events) {
      try {
        const p = JSON.parse(e.payloadJson) as {
          phase?: string; brain?: string; trained?: boolean; resultError?: string | null; error?: string | null
        }
        if (p.phase !== 'end' || typeof p.brain !== 'string' || p.trained !== false) continue
        // FB-OBSV3-R1-06: CHỈ đếm trained === false (gate chặn THẬT theo spec
        // §C.2 "trained=false ≥3"). Trước R35 skip mỗi khi trained===true nên
        // sự kiện end theo đường catch (payload KHÔNG có field trained —
        // observeBrainTrain exception-path) bị đếm nhầm thành "gate chặn" →
        // thông điệp alert sai chế độ lỗi (crash cần xem lỗi, không phải xử lý
        // dữ liệu). Exception-path vẫn hiện timeline qua brain.train end.
        const cur = blockedByBrain.get(p.brain) ?? { count: 0, latestError: null }
        cur.count++
        if (cur.latestError === null) cur.latestError = p.resultError ?? p.error ?? null
        blockedByBrain.set(p.brain, cur)
      } catch {
        /* payload rác — bỏ qua */
      }
    }
    for (const [brain, info] of blockedByBrain) {
      if (!shouldAlertTrainGateRepeat(info.count)) continue
      const targetId = `brain:${brain}`
      if (await isDuplicated('train-gate-repeat', targetId, now)) continue
      markAlerted('train-gate-repeat', targetId, now)
      emitAlert(
        {
          rule: 'train-gate-repeat',
          kind: 'brain_train_gate',
          targetId,
          brain,
          blockedCount: info.count,
          windowHours: ALERT_TRAIN_GATE_WINDOW_MS / 3600_000,
          latestError: info.latestError,
          source: 'OBS-P6 §C.2 — train bị gate chặn lặp lại; xem dữ liệu (imbalance/thiếu mẫu) thay vì thử train tiếp',
        },
        `${brain} train bị chặn ${info.count} lần/24h — gate lặp (lý do gần nhất: ${String(info.latestError ?? '—').slice(0, 100)}) — xử lý dữ liệu thay vì đốt compute thử tiếp`,
        null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule train-gate-repeat thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Rule 11 — PROVIDER-DEGRADED: model.failover cùng (provider, model) ≥ 3
 * lần/1h — nguồn LLM đang lỗi lặp (tiền lệ Zen 403 FreeTierError R32). */
async function checkProviderDegraded(now: number): Promise<void> {
  try {
    const events = await db.observationEvent.findMany({
      where: { kind: 'model.failover', ts: { gte: new Date(now - ALERT_PROVIDER_DEGRADED_WINDOW_MS) } },
      orderBy: { ts: 'desc' },
      select: { payloadJson: true },
      take: 200,
    })
    const failCount = new Map<string, { provider: string; model: string; count: number; latestError: string | null }>()
    for (const e of events) {
      try {
        const p = JSON.parse(e.payloadJson) as { provider?: string; model?: string; error?: string }
        if (typeof p.provider !== 'string' || typeof p.model !== 'string') continue
        const key = `${p.provider}:${p.model}`
        const cur = failCount.get(key) ?? { provider: p.provider, model: p.model, count: 0, latestError: null }
        cur.count++
        if (cur.latestError === null) cur.latestError = typeof p.error === 'string' ? p.error : null
        failCount.set(key, cur)
      } catch {
        /* payload rác — bỏ qua */
      }
    }
    for (const [, info] of failCount) {
      if (!shouldAlertProviderDegraded(info.count)) continue
      const targetId = `provider:${info.provider}:${info.model}`
      if (await isDuplicated('provider-degraded', targetId, now)) continue
      markAlerted('provider-degraded', targetId, now)
      emitAlert(
        {
          rule: 'provider-degraded',
          kind: 'model_provider',
          targetId,
          provider: info.provider,
          model: info.model,
          failCount: info.count,
          windowMinutes: ALERT_PROVIDER_DEGRADED_WINDOW_MS / 60_000,
          latestError: info.latestError,
          source: 'OBS-P6 §C.2 — nguồn LLM lỗi lặp (tiền lệ Zen 403 FreeTierError R32 phát hiện thủ công)',
        },
        `${info.provider}/${info.model} fail ${info.count} lần trong 1h — kiểm tra policy upstream/key (lỗi gần nhất: ${String(info.latestError ?? '—').slice(0, 100)})`,
        null,
      )
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule provider-degraded thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Rule 12 — EVO-BUDGET-BURN: search.session end có nAbandoned ≥ 3 VÀ
 * > 50% candidatesMax — Q2 bỏ chấm quá nửa, ngân sách ứng viên lệch. */
async function checkEvoBudgetBurn(now: number): Promise<void> {
  try {
    const events = await db.observationEvent.findMany({
      where: { kind: 'search.session', ts: { gte: new Date(now - ALERT_EVO_BUDGET_WINDOW_MS) } },
      orderBy: { ts: 'desc' },
      select: { payloadJson: true, ts: true },
      take: 200,
    })
    for (const e of events) {
      try {
        const p = JSON.parse(e.payloadJson) as {
          phase?: string; brain?: string; runId?: string; nAbandoned?: number; candidatesMax?: number
        }
        if (p.phase !== 'end' || typeof p.runId !== 'string') continue
        const nAbandoned = typeof p.nAbandoned === 'number' ? p.nAbandoned : 0
        const candidatesMax = typeof p.candidatesMax === 'number' ? p.candidatesMax : 0
        if (!shouldAlertEvoBudgetBurn(nAbandoned, candidatesMax)) continue
        const targetId = `brain_search_run:${p.runId}`
        if (await isDuplicated('evo-budget-burn', targetId, now)) continue
        markAlerted('evo-budget-burn', targetId, now)
        emitAlert(
          {
            rule: 'evo-budget-burn',
            kind: 'brain_search_run',
            targetId,
            rowId: p.runId,
            brain: typeof p.brain === 'string' ? p.brain : null,
            nAbandoned,
            candidatesMax,
            ratio: candidatesMax > 0 ? nAbandoned / candidatesMax : null,
            source: 'OBS-P6 §C.2 — Q2 bỏ chấm quá nửa ứng viên (vượt ngân sách wall trước khi train)',
          },
          `EVO ${String(p.brain ?? '?')} session ${p.runId.slice(0, 8)} bỏ chấm ${nAbandoned}/${candidatesMax} ứng viên theo Q2 — ngân sách ứng viên lệch (mỗi ứng viên tốn quá lâu trước khi train)`,
          null,
        )
      } catch {
        /* payload rác — bỏ qua */
      }
    }
  } catch (err) {
    console.error('[OBS-ALERT] rule evo-budget-burn thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

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
    // R4-ĐIỀU TRA (lượt 4) — 2 rule mới: (5) não chết đói nhãn (chỗ giao thức
    // quan sát từng BỎ SÓT — user: "tại sao không thấy Brain-A không tiến
    // triển"), (6) chat-trace-loss TỰ REPAIR phiên mồ côi (user: "quay lại
    // không còn thấy gì nữa"). Chạy SAU sweep để thấy việc dọn + repair
    // ngay trong cùng tick.
    await checkBrainLabelStarvation(now)
    await checkChatTraceLoss(now)
    // OBS-P6 (R34) — 5 rule thế hệ 2: EVO/NAS + eval + train gate + provider.
    await checkEvoStuck(now)
    await checkEvalStarvation(now)
    await checkTrainGateRepeat(now)
    await checkProviderDegraded(now)
    await checkEvoBudgetBurn(now)
    // alert vừa phát là fire-and-forget — flush để dedup query của TICK SAU
    // (và test) thấy ngay (an toàn: flush fail-open nội bộ ledger)
    await flushObservationQueue().catch(() => {})
  } catch (err) {
    console.error('[OBS-ALERT] runAlertChecks thất bại (fail-open):', err instanceof Error ? err.message : String(err))
  }
}
