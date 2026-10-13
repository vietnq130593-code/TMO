/**
 * Metrics DB — AgentRunRecord + ArbiterVerdict persistence bridge (Task 20-b/20-c)
 *
 * Vấn đề: dev server cache Prisma instance chính trên globalThis
 * (src/lib/db.ts). Khi `prisma db push` thêm MODEL MỚI (AgentRunRecord 20-b,
 * ArbiterVerdict 20-c) trong khi dev server đang chạy, instance chính +
 * PrismaClient class đã nạp vào process đều là bản CŨ →
 * `db.agentRunRecord`/`db.arbiterVerdict` === undefined (TypeError).
 * KHÔNG restart PM2 được → cần cầu nối.
 *
 * Giải pháp: bảng ĐÃ tồn tại trong SQLite sau db:push → truy cập qua RAW SQL
 * bằng instance hiện có ($executeRaw/$queryRaw không cần delegate). Khi
 * instance fresh (sau lần restart app kế tiếp), delegate path type-safe chạy
 * thay thế — tự lành, không cần can thiệp.
 *
 * (ToolMetric/EvalResult/CalibrationModel KHÔNG cần bridge: model có sẵn từ
 * Phase 3/4 → delegate tồn tại trên instance cũ.)
 *
 * Fail-open: mọi hàm throw lỗi DB lên caller — caller (goal-loop/chat route/
 * tracker/API route) tự .catch(() => {}) theo pattern fire-and-forget.
 */

import { db } from '@/lib/db'
// OBS-P2 hook (§C.3 đợt 2) — verdict.add (static — không chu trình)
import { observeEvent } from '@/lib/observation/ledger'

/** Shape 1 row AgentRunRecord (đủ field cho overview + 20-c wire sau) */
export interface AgentRunRecordRow {
  id: string
  sessionId: string
  messageId: string | null
  agentId: string | null
  agentName: string | null
  status: string | null
  stopReason: string | null
  cycles: number | null
  tokensUsed: number | null
  toolCalls: number | null
  toolFailures: number | null
  durationMs: number | null
  evaluatorConfidence: number | null
  complete: boolean | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
}

/** Instance chính đã có delegate agentRunRecord chưa? (fresh sau restart) */
function hasAgentRunRecordDelegate(): boolean {
  try {
    return typeof (db as unknown as Record<string, unknown>).agentRunRecord !== 'undefined'
  } catch {
    return false
  }
}

/**
 * INSERT 1 AgentRunRecord. Ưu tiên delegate (type-safe, fresh client); nếu
 * instance còn stale → raw SQL (bảng đã tồn tại sau db:push).
 * KHÔNG tạo id/createdAt ở đây nếu delegate path (Prisma tự cuid/now) —
 * raw path tự sinh id (uuid) + createdAt (now).
 */
export async function insertAgentRunRecord(params: {
  sessionId: string
  agentName: string
  status: string
  stopReason: string
  toolCalls: number
  toolFailures: number
  durationMs: number
  complete: boolean
  startedAt: Date
  completedAt: Date
  /** FIX 2026-09-14 #5: runId của run (run_xxx | sub_xxx delegation) */
  runId?: string | null
  /** FIX 2026-09-14 #5: runId cha (delegation → query mọi sub-run của 1 run) */
  parentRunId?: string | null
  /** v1 (20-b) luôn null — 20-c wire từ goal-loop metadata */
  messageId?: string | null
  agentId?: string | null
  cycles?: number | null
  tokensUsed?: number | null
  evaluatorConfidence?: number | null
  /** P4-M2 (mục #8b): id model thực chạy chính — fallback insert lúc end khi
   * row 'running' lúc start thất bại (DB lỗi tạm thời) vẫn giữ đủ metadata. */
  model?: string | null
}): Promise<void> {
  if (hasAgentRunRecordDelegate()) {
    // Fresh client — delegate path (Prisma tự sinh id cuid + createdAt)
    await db.agentRunRecord.create({
      data: {
        sessionId: params.sessionId,
        runId: params.runId ?? null,
        parentRunId: params.parentRunId ?? null,
        messageId: params.messageId ?? null,
        agentId: params.agentId ?? null,
        agentName: params.agentName,
        model: params.model ?? null,
        status: params.status,
        stopReason: params.stopReason,
        cycles: params.cycles ?? null,
        tokensUsed: params.tokensUsed ?? null,
        toolCalls: params.toolCalls,
        toolFailures: params.toolFailures,
        durationMs: params.durationMs,
        evaluatorConfidence: params.evaluatorConfidence ?? null,
        complete: params.complete,
        startedAt: params.startedAt,
        completedAt: params.completedAt,
      },
    })
    return
  }

  // Stale client — raw SQL bridge (id/createdAt sinh thủ công vì Prisma
  // implement @default(cuid()/now()) client-side, không phải DB default)
  const id = randomId()
  const createdAt = new Date()
  await db.$executeRaw`
    INSERT INTO AgentRunRecord (
      id, sessionId, runId, parentRunId, messageId, agentId, agentName, model, status, stopReason,
      cycles, tokensUsed, toolCalls, toolFailures, durationMs,
      evaluatorConfidence, complete, startedAt, completedAt, createdAt
    ) VALUES (
      ${id}, ${params.sessionId}, ${params.runId ?? null}, ${params.parentRunId ?? null},
      ${params.messageId ?? null}, ${params.agentId ?? null},
      ${params.agentName}, ${params.model ?? null}, ${params.status}, ${params.stopReason},
      ${params.cycles ?? null}, ${params.tokensUsed ?? null}, ${params.toolCalls},
      ${params.toolFailures}, ${params.durationMs},
      ${params.evaluatorConfidence ?? null}, ${params.complete ? 1 : 0},
      ${params.startedAt}, ${params.completedAt}, ${createdAt}
    )
  `
}

/**
 * SELECT AgentRunRecord từ `since` trở đi, mới nhất trước. Delegate path nếu
 * fresh; raw SQL nếu stale (boolean `complete` trong SQLite là 0/1 → coerce).
 */
export async function findAgentRunRecordsSince(since: Date): Promise<AgentRunRecordRow[]> {
  if (hasAgentRunRecordDelegate()) {
    return db.agentRunRecord.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    })
  }

  const raw = await db.$queryRaw<
    Array<{
      id: string
      sessionId: string
      runId: string | null
      parentRunId: string | null
      messageId: string | null
      agentId: string | null
      agentName: string | null
      status: string | null
      stopReason: string | null
      cycles: number | null
      tokensUsed: number | null
      toolCalls: number | null
      toolFailures: number | null
      durationMs: number | null
      evaluatorConfidence: number | null
      complete: number | null
      startedAt: Date | null
      completedAt: Date | null
      createdAt: Date
    }>
  >`
    SELECT id, sessionId, runId, parentRunId, messageId, agentId, agentName, status, stopReason,
      cycles, tokensUsed, toolCalls, toolFailures, durationMs,
      evaluatorConfidence, complete, startedAt, completedAt, createdAt
    FROM AgentRunRecord
    WHERE createdAt >= ${since}
    ORDER BY createdAt DESC
  `
  return raw.map(r => ({
    ...r,
    complete: r.complete === null || r.complete === undefined ? null : !!r.complete,
  }))
}

/** Id duy nhất cho raw INSERT (uuid — không phụ thuộc internals của Prisma) */
function randomId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() || `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  } catch {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

// ==================== ArbiterVerdict — Task 20-c ====================

/** Instance chính đã có delegate arbiterVerdict chưa? (fresh sau restart) */
function hasArbiterVerdictDelegate(client: PrismaClientLike = db): boolean {
  try {
    return typeof (client as unknown as Record<string, unknown>).arbiterVerdict !== 'undefined'
  } catch {
    return false
  }
}

/**
 * INSERT 1 ArbiterVerdict — verdict EFFECTIVE (sau verify-guard) của trọng tài
 * độc lập cho 1 chu kỳ EVALUATE. Delegate path nếu fresh, raw SQL nếu stale.
 */
export async function insertArbiterVerdict(params: {
  sessionId: string
  messageId?: string | null
  agentName?: string | null
  cycle: number
  complete: boolean
  confidence: number
  verified: boolean
  /** JSON string của các mục còn thiếu (EvalVerdict.missing) */
  missing?: string | null
  rootCause?: string | null
  forcedDowngrade?: boolean
}): Promise<void> {
  if (hasArbiterVerdictDelegate()) {
    await db.arbiterVerdict.create({
      data: {
        sessionId: params.sessionId,
        messageId: params.messageId ?? null,
        agentName: params.agentName ?? null,
        cycle: params.cycle,
        complete: params.complete,
        confidence: params.confidence,
        verified: params.verified,
        missing: params.missing ?? null,
        rootCause: params.rootCause ?? null,
        forcedDowngrade: params.forcedDowngrade ?? false,
      },
    })
    // OBS-P2 hook (§C.3 đợt 2 — verdict.add, nhánh delegate)
    observeEvent({
      actor: params.agentName ? `agent:${params.agentName}` : 'system',
      kind: 'verdict.add',
      sessionId: params.sessionId,
      table: 'ArbiterVerdict',
      summary: `Phán quyết cycle ${params.cycle}: ${params.complete ? 'đủ' : 'thiếu'} · conf ${params.confidence.toFixed(2)} · ${params.verified ? 'verified' : 'unverified'}`,
      payload: {
        sessionId: params.sessionId, cycle: params.cycle, complete: params.complete,
        confidence: params.confidence, verified: params.verified,
        forcedDowngrade: params.forcedDowngrade ?? false,
      },
    })
    return
  }

  const id = randomId()
  const createdAt = new Date()
  await db.$executeRaw`
    INSERT INTO ArbiterVerdict (
      id, sessionId, messageId, agentName, cycle, complete, confidence, verified,
      missing, rootCause, forcedDowngrade, runStopReason, runComplete, outcome, outcomeAt, createdAt
    ) VALUES (
      ${id}, ${params.sessionId}, ${params.messageId ?? null}, ${params.agentName ?? null},
      ${params.cycle}, ${params.complete ? 1 : 0}, ${params.confidence}, ${params.verified ? 1 : 0},
      ${params.missing ?? null}, ${params.rootCause ?? null}, ${params.forcedDowngrade ? 1 : 0},
      NULL, NULL, NULL, NULL, ${createdAt}
    )
  `
  // OBS-P2 hook (§C.3 đợt 2 — verdict.add, nhánh raw fallback)
  observeEvent({
    actor: params.agentName ? `agent:${params.agentName}` : 'system',
    kind: 'verdict.add',
    sessionId: params.sessionId,
    table: 'ArbiterVerdict',
    rowKey: id,
    summary: `Phán quyết cycle ${params.cycle}: ${params.complete ? 'đủ' : 'thiếu'} · conf ${params.confidence.toFixed(2)} · ${params.verified ? 'verified' : 'unverified'}`,
    payload: {
      sessionId: params.sessionId, cycle: params.cycle, complete: params.complete,
      confidence: params.confidence, verified: params.verified,
      forcedDowngrade: params.forcedDowngrade ?? false,
    },
  })
}

/** Shape 1 ArbiterVerdict ĐÃ resolve — dữ liệu tính Brier/ECE của trọng tài */
export interface ArbiterVerdictCalibrationRow {
  id: string
  sessionId: string
  cycle: number
  complete: boolean
  confidence: number
  verified: boolean
  forcedDowngrade: boolean
  outcome: string
  runComplete: boolean | null
  runStopReason: string | null
  createdAt: Date
}

/**
 * SELECT các ArbiterVerdict ĐÃ resolve (outcome IS NOT NULL), mới nhất trước —
 * cho GET /api/eval/calibration tính Brier/ECE của trọng tài.
 */
export async function findArbiterVerdictsForCalibration(limit = 2000): Promise<ArbiterVerdictCalibrationRow[]> {
  const capped = Math.max(1, Math.min(limit, 10_000))
  if (hasArbiterVerdictDelegate()) {
    const rows = await db.arbiterVerdict.findMany({
      where: { outcome: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: capped,
    })
    // `outcome: { not: null }` không narrow type của Prisma → filter + assert
    return rows
      .filter(r => r.outcome !== null)
      .map(r => ({ ...r, outcome: r.outcome as string }))
  }

  const raw = await db.$queryRaw<
    Array<{
      id: string
      sessionId: string
      cycle: number
      complete: number
      confidence: number
      verified: number
      forcedDowngrade: number
      outcome: string
      runComplete: number | null
      runStopReason: string | null
      createdAt: Date
    }>
  >`
    SELECT id, sessionId, cycle, complete, confidence, verified, forcedDowngrade,
      outcome, runComplete, runStopReason, createdAt
    FROM ArbiterVerdict
    WHERE outcome IS NOT NULL
    ORDER BY createdAt DESC
    LIMIT ${capped}
  `
  return raw.map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    cycle: r.cycle,
    complete: !!r.complete,
    confidence: r.confidence,
    verified: !!r.verified,
    forcedDowngrade: !!r.forcedDowngrade,
    outcome: r.outcome,
    runComplete: r.runComplete === null || r.runComplete === undefined ? null : !!r.runComplete,
    runStopReason: r.runStopReason,
    createdAt: r.createdAt,
  }))
}

/** Shape 1 ArbiterVerdict ĐÃ resolve cho Verdict Scorecard (P1-M1) — đủ cột
 *  cho confusion matrix (complete × runComplete) + phân tầng agentName +
 *  forcedDowngrade + confidence (AUC-PR/Brier/ECE). */
export interface ArbiterVerdictScorecardRow {
  id: string
  sessionId: string
  agentName: string | null
  cycle: number
  complete: boolean
  confidence: number
  verified: boolean
  forcedDowngrade: boolean
  outcome: string
  runComplete: boolean | null
  runStopReason: string | null
  createdAt: Date
}

/**
 * SELECT các ArbiterVerdict ĐÃ resolve trong `windowDays` gần nhất, mới nhất
 * trước, cap 5000 — cho P1-M1 Verdict Scorecard (confusion matrix của lời
 * tuyên bố "complete" của trọng tài). Delegate path nếu Prisma instance fresh,
 * raw SQL bridge nếu stale (pattern findArbiterVerdictsForCalibration).
 */
export async function findResolvedVerdictsForScorecard(windowDays = 30): Promise<ArbiterVerdictScorecardRow[]> {
  const days = Math.max(1, Math.min(windowDays, 365))
  const cap = 5000
  const since = new Date(Date.now() - days * 24 * 3600 * 1000)
  if (hasArbiterVerdictDelegate()) {
    const rows = await db.arbiterVerdict.findMany({
      where: { outcome: { not: null }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: cap,
    })
    return rows
      .filter(r => r.outcome !== null)
      .map(r => ({ ...r, outcome: r.outcome as string }))
  }

  const raw = await db.$queryRaw<
    Array<{
      id: string
      sessionId: string
      agentName: string | null
      cycle: number
      complete: number
      confidence: number
      verified: number
      forcedDowngrade: number
      outcome: string
      runComplete: number | null
      runStopReason: string | null
      createdAt: Date
    }>
  >`
    SELECT id, sessionId, agentName, cycle, complete, confidence, verified, forcedDowngrade,
      outcome, runComplete, runStopReason, createdAt
    FROM ArbiterVerdict
    WHERE outcome IS NOT NULL AND createdAt >= ${since}
    ORDER BY createdAt DESC
    LIMIT ${cap}
  `
  return raw.map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    agentName: r.agentName,
    cycle: r.cycle,
    complete: !!r.complete,
    confidence: r.confidence,
    verified: !!r.verified,
    forcedDowngrade: !!r.forcedDowngrade,
    outcome: r.outcome,
    runComplete: r.runComplete === null || r.runComplete === undefined ? null : !!r.runComplete,
    runStopReason: r.runStopReason,
    createdAt: r.createdAt,
  }))
}

/**
 * RESOLVE các verdict CHƯA resolve của session khi run kết thúc:
 *   outcome = (verdict.complete === runComplete) ? 'confirmed' : 'refuted'
 * Trả về số verdict đã resolve. Fail-open: lỗi DB → throw lên caller .catch.
 */
export async function resolveArbiterVerdicts(
  sessionId: string,
  runComplete: boolean,
  runStopReason: string,
): Promise<number> {
  const { total } = await resolveArbiterVerdictsDetailed(sessionId, runComplete, runStopReason)
  return total
}

/**
 * P6-M1 (BLUEPRINT-STATS-LEARNING §P6-M1, mục #15): bản đầy đủ của
 * resolveArbiterVerdicts — trả kèm breakdown confirmed/refuted để goal-loop
 * TÍNH REWARD cho credit assignment (+1 confirmed ∧ runComplete / −1 refuted /
 * 0 pending-bỏ — quy ước reward §P6-M2). resolveArbiterVerdicts (cũ) ủy nhiệm
 * và giữ return number — giữ làm API ổn định (additive-only theo nguyên tắc
 * 5 blueprint; FB-P6-R1-C-01: hiện KHÔNG còn caller nội bộ nào — caller duy
 * nhất goal-loop đã chuyển sang Detailed từ chính commit P6).
 */
/** Kiểu client tối thiểu resolveArbiterVerdictsDetailed cần (FB-P6-R3-01 DI). */
type PrismaClientLike = typeof db

export async function resolveArbiterVerdictsDetailed(
  sessionId: string,
  runComplete: boolean,
  runStopReason: string,
  /** FB-P6-R3-01: dependency-injection cho test pin raw-path (client stale =
   *  không có delegate arbiterVerdict). Mặc định db dùng chung — không đổi
   *  hành vi caller nào. */
  client: PrismaClientLike = db,
): Promise<{ total: number; confirmed: number; refuted: number }> {
  const now = new Date()
  if (hasArbiterVerdictDelegate(client)) {
    // updateMany không set giá trị per-row được → 2 nhóm confirmed/refuted
    const confirmed = await client.arbiterVerdict.updateMany({
      where: { sessionId, outcome: null, complete: runComplete },
      data: { outcome: 'confirmed', outcomeAt: now, runStopReason, runComplete },
    })
    const refuted = await client.arbiterVerdict.updateMany({
      where: { sessionId, outcome: null, complete: !runComplete },
      data: { outcome: 'refuted', outcomeAt: now, runStopReason, runComplete },
    })
    return { total: confirmed.count + refuted.count, confirmed: confirmed.count, refuted: refuted.count }
  }

  // FB-P6-R1-C-02: 2 lệnh raw gộp trong MỘT $transaction — bản trước tách rời
  // nên crash/giẽ giữa 2 lệnh để lại resolve nửa vời (confirmed đã đóng,
  // refuted kẹt pending); transaction array-form chạy tuần tự cùng commit/rollback.
  const [confirmedN, refutedN] = await client.$transaction([
    client.$executeRaw`
      UPDATE ArbiterVerdict
      SET outcome = 'confirmed', outcomeAt = ${now},
          runStopReason = ${runStopReason}, runComplete = ${runComplete ? 1 : 0}
      WHERE sessionId = ${sessionId} AND outcome IS NULL AND complete = ${runComplete ? 1 : 0}
    `,
    client.$executeRaw`
      UPDATE ArbiterVerdict
      SET outcome = 'refuted', outcomeAt = ${now},
          runStopReason = ${runStopReason}, runComplete = ${runComplete ? 1 : 0}
      WHERE sessionId = ${sessionId} AND outcome IS NULL AND complete = ${runComplete ? 0 : 1}
    `,
  ])
  return { total: Number(confirmedN) + Number(refutedN), confirmed: Number(confirmedN), refuted: Number(refutedN) }
}

// ==================== AgentRunRecord — start/end lifecycle (Task 20-c) ====================

/**
 * INSERT 1 AgentRunRecord lúc run START (status='running', startedAt=now) —
 * giúp /api/metrics/overview runs.active ≠ 0 trong lúc run đang chạy.
 * Goal-loop là nguồn sự thật cho lifecycle của chat run: row này sẽ được
 * updateLatestAgentRunRecord() cập nhật đầy đủ khi run kết thúc.
 */
export async function insertAgentRunRecordRunning(params: {
  sessionId: string
  agentId?: string | null
  agentName?: string | null
  startedAt?: Date
  /** FIX 2026-09-14 #5: runId — row 'running' khớp ĐÚNG run khi update lúc end */
  runId?: string | null
  parentRunId?: string | null
  /** P4-M2 (mục #8b): id model thực chạy chính của run — truyền từ goal-loop
   * (agentModel) lúc insert; nullable-additive, row cũ không có → null. */
  model?: string | null
}): Promise<void> {
  const startedAt = params.startedAt ?? new Date()
  if (hasAgentRunRecordDelegate()) {
    await db.agentRunRecord.create({
      data: {
        sessionId: params.sessionId,
        runId: params.runId ?? null,
        parentRunId: params.parentRunId ?? null,
        agentId: params.agentId ?? null,
        agentName: params.agentName ?? null,
        model: params.model ?? null,
        status: 'running',
        startedAt,
      },
    })
    return
  }

  const id = randomId()
  const createdAt = new Date()
  await db.$executeRaw`
    INSERT INTO AgentRunRecord (
      id, sessionId, runId, parentRunId, messageId, agentId, agentName, model, status, stopReason,
      cycles, tokensUsed, toolCalls, toolFailures, durationMs,
      evaluatorConfidence, complete, startedAt, completedAt, createdAt
    ) VALUES (
      ${id}, ${params.sessionId}, ${params.runId ?? null}, ${params.parentRunId ?? null},
      NULL, ${params.agentId ?? null}, ${params.agentName ?? null}, ${params.model ?? null},
      'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      ${startedAt}, NULL, ${createdAt}
    )
  `
}

/** Các field có thể UPDATE trên 1 AgentRunRecord (chỉ field truyền vào mới set) */
export interface AgentRunRecordUpdate {
  messageId?: string | null
  agentId?: string | null
  agentName?: string | null
  /** P4-M2 (mục #8b): id model thực chạy chính của run */
  model?: string | null
  status?: string
  stopReason?: string
  cycles?: number
  tokensUsed?: number
  toolCalls?: number
  toolFailures?: number
  durationMs?: number
  evaluatorConfidence?: number | null
  complete?: boolean
  startedAt?: Date
  completedAt?: Date
}

/** Build SET clauses cho raw UPDATE — chỉ field có mặt trong data object */
function buildAgentRunSetClauses(data: AgentRunRecordUpdate): { sets: string[]; args: unknown[] } {
  const sets: string[] = []
  const args: unknown[] = []
  if ('messageId' in data) { sets.push('messageId = ?'); args.push(data.messageId ?? null) }
  if ('agentId' in data) { sets.push('agentId = ?'); args.push(data.agentId ?? null) }
  if ('agentName' in data) { sets.push('agentName = ?'); args.push(data.agentName ?? null) }
  if ('model' in data) { sets.push('model = ?'); args.push(data.model ?? null) }
  if ('status' in data) { sets.push('status = ?'); args.push(data.status ?? null) }
  if ('stopReason' in data) { sets.push('stopReason = ?'); args.push(data.stopReason ?? null) }
  if ('cycles' in data) { sets.push('cycles = ?'); args.push(data.cycles ?? null) }
  if ('tokensUsed' in data) { sets.push('tokensUsed = ?'); args.push(data.tokensUsed ?? null) }
  if ('toolCalls' in data) { sets.push('toolCalls = ?'); args.push(data.toolCalls ?? null) }
  if ('toolFailures' in data) { sets.push('toolFailures = ?'); args.push(data.toolFailures ?? null) }
  if ('durationMs' in data) { sets.push('durationMs = ?'); args.push(data.durationMs ?? null) }
  if ('evaluatorConfidence' in data) { sets.push('evaluatorConfidence = ?'); args.push(data.evaluatorConfidence ?? null) }
  if ('complete' in data) { sets.push('complete = ?'); args.push(data.complete === null || data.complete === undefined ? null : (data.complete ? 1 : 0)) }
  if ('startedAt' in data) { sets.push('startedAt = ?'); args.push(data.startedAt ?? null) }
  if ('completedAt' in data) { sets.push('completedAt = ?'); args.push(data.completedAt ?? null) }
  return { sets, args }
}

/** Build Prisma data object cho delegate UPDATE — chỉ field có mặt trong data */
function buildAgentRunDelegateData(data: AgentRunRecordUpdate): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(data) as Array<keyof AgentRunRecordUpdate>) {
    if (key === 'complete') {
      out[key] = data.complete === undefined ? undefined : (data.complete === null ? null : data.complete)
    } else {
      out[key] = data[key]
    }
  }
  return out
}

/**
 * UPDATE row AgentRunRecord của run (FIX 2026-09-14 #5: ưu tiên khớp THEO
 * runId — chính xác ngay cả khi có delegation rows chen giữa; fallback row
 * mới nhất theo createdAt như cũ khi runId không có/không khớp) — goal-loop
 * wire metadata thật (cycles/tokensUsed/evaluatorConfidence/stopReason...)
 * khi run kết thúc; chat route link messageId sau khi message persist.
 * Trả về số row đã update (0 = chưa có row nào khớp).
 */
export async function updateLatestAgentRunRecord(
  sessionId: string,
  data: AgentRunRecordUpdate,
  runId?: string | null,
): Promise<number> {
  const { sets, args } = buildAgentRunSetClauses(data)
  if (sets.length === 0) return 0

  if (hasAgentRunRecordDelegate()) {
    let targetId: string | null = null
    if (runId) {
      const byRunId = await db.agentRunRecord.findFirst({
        where: { sessionId, runId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      targetId = byRunId?.id ?? null
    }
    if (!targetId) {
      const latest = await db.agentRunRecord.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      targetId = latest?.id ?? null
    }
    if (!targetId) return 0
    await db.agentRunRecord.update({
      where: { id: targetId },
      data: buildAgentRunDelegateData(data),
    })
    return 1
  }

  // Raw path: subquery chọn row theo runId (nếu có) else mới nhất theo
  // createdAt — 1 statement atomic. Params: SET args → cond args.
  const run = async (cond: string, condArgs: unknown[]): Promise<number> =>
    db.$executeRawUnsafe(
      `UPDATE AgentRunRecord SET ${sets.join(', ')} WHERE id = (
         SELECT id FROM AgentRunRecord WHERE ${cond} ORDER BY createdAt DESC LIMIT 1
       )`,
      ...args,
      ...condArgs,
    )
  if (runId) {
    const n = await run('sessionId = ? AND runId = ?', [sessionId, runId])
    if (n > 0) return n
    // Row không khớp runId (insert bởi code cũ chưa có cột runId) → fallback
    return run('sessionId = ?', [sessionId])
  }
  return run('sessionId = ?', [sessionId])
}
