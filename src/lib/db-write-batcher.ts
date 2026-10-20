/**
 * ============================================================================
 * DB WRITE BATCHER — hàng đợi ghi đơn writer (BLUEPRINT-R17BC v0.2 · W1/S1)
 * ============================================================================
 * Bối cảnh (bằng chứng — Bug_v2 OBS-1 + db.ts Task 33 :217-234):
 * SQLite 1-writer bão hòa dưới cụm ghi run-close ("metrics + verdict resolve +
 * QEntry + token persist + auto-train + auto-learn + ledger đồng thời") →
 * "Socket timeout" tái xuất (điều kiện REOPEN tại db.ts:132 đã thỏa).
 *
 * Hợp đồng bền (TRUNG THỰC — REVIEW-1 P0-1.3, KHÔNG tuyên "crash-proof"):
 *   at-least-once  : qua contention (withSqliteRetry 2 pha) + clean self-exit
 *                    (drainWriteQueueForExit bound TMO_EXIT_WRITE_DRAIN_MS ≤ 3s).
 *   at-most-once    : qua SIGKILL/kernel OOM — cửa sổ mất ≤ FLUSH_MS (1s) ×
 *                    ≤ MAX_OPS (200). In-memory queue không sống qua crash —
 *                    đây là danh hiệu TRUNG THỰC, không phải nhược điểm che giấu.
 *
 * 2 làn op (REVIEW-1 P0-3 — bảng AUDIT BLUEPRINT-R17BC §4.2):
 *   SetOp : set-semantics TUYỆT ĐỐI — duy nhất làn được khai idempotencyKey →
 *           coalesce last-wins TRONG 1 batch đang chờ. RMW (increment/decrement/
 *           multiply/divide trong data) bị deep-scan TypeError ngay tại enqueue.
 *   RawOp : RMW đọc-hiện-tại-tính-lại — KHÔNG idempotencyKey, không bao giờ
 *           coalesce, FIFO nguyên vẹn trong transaction.
 * Đường direct-bắt-buộc (không qua batcher — hợp đồng §4.2): mọi read, mọi op
 * cần id trả về, mọi op control-flow (return quyết nhánh — vd
 * updateLatestAgentRunRecord), ledger writeOne (RO-4 seq single-writer).
 *
 * Flag DB_WRITE_QUEUE (default off — anti-goal §7.7 default-OFF):
 *   off  = pass-through: enqueue* thực thi op TRỰC TIẾP với withSqliteRetry —
 *          hành vi identical hôm nay; chủ sở hữu retry là batcher ở cả 2 mode
 *          (REVIEW-1 P1-2). Delta duy nhất của off-mode: 1 dòng console.warn
 *          khi op fail (log-only, KHÔNG thêm DB write — ghi chú fixbug W1).
 *   on   = queue + flush 2 pha (batch tx → per-op salvage) + 4 trigger
 *          (timer FLUSH_MS / depth MAX_OPS / flushNow() tại run-close /
 *          drainWriteQueueForExit trong selfExitWithDrain).
 *
 * Flush 2 pha (REVIEW-1 P0-2):
 *   Pha 1  : db.$transaction(apply FIFO, timeout TX_TIMEOUT) qua withSqliteRetry.
 *   Pha 2  : pha 1 fail non-transient → CHIA NHỎ — mỗi op 1 mini-tx với
 *            withSqliteRetry riêng; op poison (P2025/constraint) → debt +
 *            loại khỏi batch (không chặn op lành); op lành commit đủ.
 *   Hết 2 pha (DB xuống thật): giữ batch chờ flush kế — bound RETAINED_MAX=2;
 *   tràn → drop batch CŨ nhất: MỖI op 1 debt riêng + waiters reject
 *   BatchDroppedError (REVIEW-1 P1-1 — promise không treo vô định).
 *
 * Hold-time (REVIEW-1 P1-5): stats.holdMs đo thời gian giữ write-lock của
 * batch tx; vượt HOLD_TARGET → chunkSize tự halve (min 25) flush kế; dưới
 * ½ target → double (max MAX_OPS) — không block claim/heartbeat/checkout của
 * worker + ledger interactive tx quá lâu.
 */
import type { Prisma } from '@prisma/client'
import { PrismaClient } from '@prisma/client'
import { db, withSqliteRetry, isTransientSqliteError, firstErrLine } from './db'
import { recordDebtIssue } from './execution/debt-ledger'

// ==================== CẤU HÌNH (env — default theo blueprint v0.2) ====================
function envFlag(name: string): boolean {
  const v = (process.env[name] || '').trim().toLowerCase()
  return v === 'on' || v === '1' || v === 'true'
}
function envInt(name: string, def: number, min: number, max: number): number {
  const raw = parseInt(process.env[name] || '', 10)
  if (!Number.isFinite(raw)) return def
  return Math.max(min, Math.min(max, raw))
}

/**
 * ĐỌC ĐỘNG mỗi lần gọi (không freeze lúc import) — r137/r138 cần đổi mode
 * TRONG CÙNG 1 process test (bun test chạy mọi file chung 1 pid — preload
 * Task 54). Perf không đáng kể (so chuỗi 8 ký tự); semantics pilot pm2 giữ
 * nguyên (env nạp vào process lúc boot — đổi .env vẫn cần restart).
 */
function queueEnabled(): boolean {
  return envFlag('DB_WRITE_QUEUE')
}
const FLUSH_MS = envInt('DB_WRITE_BATCH_FLUSH_MS', 1000, 100, 60_000)
const MAX_OPS = envInt('DB_WRITE_BATCH_MAX_OPS', 200, 1, 2000)
const TX_TIMEOUT_MS = envInt('DB_WRITE_BATCH_TX_TIMEOUT_MS', 30_000, 5_000, 120_000)
const HOLD_TARGET_MS = envInt('DB_WRITE_BATCH_HOLD_TARGET_MS', 300, 50, 10_000)
const RETAINED_MAX = 2 // cố định theo blueprint v0.2 §4.1c — không env (hợp đồng bound)

// ==================== KIỂU — 2 làn tách bạch (P0-3 + P2-1) ====================
/** Union ĐÓNG theo bảng AUDIT §4.2 — mở delegate = sửa bảng audit trước (single source). */
export type BatchableModel =
  | 'toolMetric'
  | 'workingMemory'
  | 'dailyTokenUsage'
  | 'dailyTokenByProvider'
  | 'dailyTokenByProviderSlot'
  | 'dailyTokenByProviderModel'
  | 'dailyTokenByAgent'
  | 'localRelationship'
  | 'agentInsight'
  | 'learningLog'
  | 'autoLearnRecord'

/** Set-semantics TUYỆT ĐỐI — data KHÔNG chứa atomic RMW (deep-scan TypeError). */
export interface SetOp {
  kind: 'create' | 'upsert' | 'update'
  model: BatchableModel
  /** create/update payload (create) hoặc update payload (upsert/update) */
  data?: unknown
  /** where cho update/upsert */
  where?: unknown
  /** create payload cho upsert */
  create?: unknown
  /** update payload cho upsert (SET tuyệt đối — KHÔNG atomic RMW) */
  update?: unknown
  /** DUY NHẤT làn này được khai → coalesce last-wins trong 1 batch đang chờ */
  idempotencyKey?: string
}
/** RMW đọc-hiện-tại-tính-lại — FIFO nguyên vẹn, không bao giờ coalesce. */
export interface RawOp {
  kind: 'raw'
  label?: string
  fn: (tx: Prisma.TransactionClient) => Promise<void>
}
export type WriteOp = SetOp | RawOp

export interface EnqueueOpts {
  /** nhãn log/debt — khuyến nghị dạng "site(operation)" như withSqliteRetry label */
  label?: string
}
/** Reject khi op rơi vào batch bị drop theo bound RETAINED_MAX (P1-1). */
export class BatchDroppedError extends Error {
  constructor(label: string, reason: string) {
    super(`[WriteBatcher] Batch bị drop (bound ${RETAINED_MAX} batch chờ) — op "${label}" mất: ${reason}`)
    this.name = 'BatchDroppedError'
  }
}

// ==================== DELEGATE-MAP TYPED (P2-1 — switch exhaustive, không any) ====================
type DelegateClient = Prisma.TransactionClient // full PrismaClient thỏa Subset — dùng 1 type cho cả db lẫn tx
function delegateFor(c: DelegateClient, model: BatchableModel) {
  switch (model) {
    case 'toolMetric': return c.toolMetric
    case 'workingMemory': return c.workingMemory
    case 'dailyTokenUsage': return c.dailyTokenUsage
    case 'dailyTokenByProvider': return c.dailyTokenByProvider
    case 'dailyTokenByProviderSlot': return c.dailyTokenByProviderSlot
    case 'dailyTokenByProviderModel': return c.dailyTokenByProviderModel
    case 'dailyTokenByAgent': return c.dailyTokenByAgent
    case 'localRelationship': return c.localRelationship
    case 'agentInsight': return c.agentInsight
    case 'learningLog': return c.learningLog
    case 'autoLearnRecord': return c.autoLearnRecord
  }
}

// ==================== TYPE-GUARD RMW (P0-3) ====================
const RMW_KEYS = new Set(['increment', 'decrement', 'multiply', 'divide'])
/** Deep-scan payload Prisma — phát hiện atomic RMW ở mọi cấp. Trả về path đầu tiên tìm thấy. */
function findRmwKey(value: unknown, path: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value instanceof Date || value instanceof PrismaClient) return null
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (RMW_KEYS.has(k)) return `${path}.${k}`
    const nested = findRmwKey(v, `${path}.${k}`)
    if (nested) return nested
  }
  return null
}
function assertSetSemantics(op: SetOp, label: string): void {
  const scans: Array<[unknown, string]> = [
    [op.data as unknown, 'data'],
    [op.create as unknown, 'create'],
    [op.update as unknown, 'update'],
  ]
  for (const [payload, field] of scans) {
    if (payload === undefined || payload === null) continue
    const hit = findRmwKey(payload, field)
    if (hit) {
      throw new TypeError(
        `[WriteBatcher] SetOp "${label}" chứa atomic RMW tại ${hit} — vi phạm hợp đồng set-semantics (BLUEPRINT-R17BC §4.1a/P0-3). RMW phải đi làn RawOp hoặc đường direct; op bị TỪ CHỐI tại enqueue (không vào hàng đợi).`,
      )
    }
  }
}

// ==================== ÁP DỤNG 1 OP LÊN CLIENT (db trực tiếp hoặc tx) ====================
async function applyOp(c: DelegateClient, op: WriteOp): Promise<void> {
  if (op.kind === 'raw') {
    await op.fn(c)
    return
  }
  const d = delegateFor(c, op.model) as unknown as {
    // Cast TẬI BIÊN APPLY duy nhất (P2-1): delegate-map switch exhaustive bảo
    // đúng model trước đó; payload tương ứng model đã được bảng audit §4.2
    // đối chiếu từng call-site — không any, chỉ thu hẹp callable tại biên.
    create: (args: { data: unknown }) => Promise<unknown>
    upsert: (args: { where: unknown; create: unknown; update: unknown }) => Promise<unknown>
    update: (args: { where: unknown; data: unknown }) => Promise<unknown>
  }
  switch (op.kind) {
    case 'create':
      await d.create({ data: op.data as never })
      return
    case 'upsert':
      await d.upsert({ where: op.where as never, create: op.create as never, update: op.update as never })
      return
    case 'update':
      await d.update({ where: op.where as never, data: op.data as never })
      return
  }
}

// ==================== STATS (P2-3 — 8 số + ring p95) ====================
export interface WriteQueueStats {
  enabled: boolean
  queueDepth: number
  retainedBatches: number
  flushing: boolean
  lastBatchSize: number
  lastFlushMs: number
  lastHoldMs: number
  chunkSize: number
  flushP95Ms: number
  flushedBatches: number
  flushedOps: number
  coalescedOps: number
  dropCount: number
  retryCount: number
  salvageSplits: number
  poisonCount: number
}
const flushMsRing: number[] = []
function p95FromRing(): number {
  if (flushMsRing.length === 0) return 0
  const sorted = [...flushMsRing].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
}

// ==================== HÀNG ĐỢI (globalThis guard — pattern q-table/goal-loop-worker) ====================
interface QueuedEntry {
  op: WriteOp
  label: string
  wait: boolean
  resolve?: () => void
  reject?: (err: unknown) => void
}
interface BatcherState {
  queue: QueuedEntry[]
  retained: QueuedEntry[][] // batch đã fail cả 2 pha — chờ flush kế (bound RETAINED_MAX)
  timer: ReturnType<typeof setTimeout> | null
  flushing: boolean
  flushChain: Promise<void>
  chunkSize: number
  stats: Omit<WriteQueueStats, 'enabled' | 'queueDepth' | 'retainedBatches' | 'flushing' | 'flushP95Ms' | 'chunkSize'>
}
const globalForBatcher = globalThis as unknown as { __tmoWriteBatcher?: BatcherState }
const state: BatcherState =
  globalForBatcher.__tmoWriteBatcher ??
  (globalForBatcher.__tmoWriteBatcher = {
    queue: [],
    retained: [],
    timer: null,
    flushing: false,
    flushChain: Promise.resolve(),
    chunkSize: MAX_OPS,
    stats: {
      lastBatchSize: 0,
      lastFlushMs: 0,
      lastHoldMs: 0,
      flushedBatches: 0,
      flushedOps: 0,
      coalescedOps: 0,
      dropCount: 0,
      retryCount: 0,
      salvageSplits: 0,
      poisonCount: 0,
    },
  })

function scheduleFlush(): void {
  if (!queueEnabled()) return
  if (state.timer || state.flushing) return
  if (state.queue.length === 0 && state.retained.length === 0) return
  state.timer = setTimeout(() => {
    state.timer = null
    void runFlush().catch(() => { /* runFlush tự xử lý lỗi nội bộ */ })
  }, FLUSH_MS)
  state.timer.unref?.() // không giữ event loop vì timer flush (đường nền)
}

/** Debt cho 1 op mất (drop bound / poison) — fail-open tuyệt đối (R17 6.1c pattern). */
async function debtLostOp(label: string, reason: string, evidence: string): Promise<void> {
  try {
    await recordDebtIssue({
      issue: `Write batch mất op "${label}" — ${reason}`,
      kind: 'infra',
      evidence,
    })
  } catch { /* debt-ledger fail-open — không được phép throw tại đây */ }
}

/** Chạy flush nối tiếp (chống đồng thời 2 flush — đơn writer trong process). */
function runFlush(): Promise<void> {
  const next = state.flushChain.then(() => flushOnce())
  state.flushChain = next.then(() => undefined, () => undefined)
  return next
}

async function flushOnce(): Promise<void> {
  if (state.retained.length > 0) {
    // Thử lại batch fail trước tiên (FIFO) — hợp đồng §4.1c "giữ batch chờ flush kế"
    for (const batch of state.retained.splice(0)) {
      const ok = await tryBatch(batch)
      if (!ok) {
        state.retained.push(batch) // vẫn fail → trả lại vị trí, thử batch sau (nếu DB down thì batch sau cũng fail)
        if (state.retained.length >= RETAINED_MAX) break
      }
    }
  }
  if (state.queue.length === 0) {
    if (state.retained.length === 0) return
    scheduleFlush()
    return
  }
  const take = Math.min(state.chunkSize, state.queue.length)
  const batch = state.queue.splice(0, take)
  const ok = await tryBatch(batch)
  if (!ok) {
    state.retained.push(batch)
    if (state.retained.length > RETAINED_MAX) {
      // Drop batch CŨ nhất — P1-1: reject waiters BatchDroppedError + MỖI op 1 debt
      const oldest = state.retained.shift() as QueuedEntry[]
      state.stats.dropCount += oldest.length
      console.error(`[WriteBatcher] Drop batch cũ nhất ${oldest.length} ops (bound ${RETAINED_MAX} batch chờ tràn)`)
      for (const e of oldest) {
        void debtLostOp(e.label, 'batch drop theo bound RETAINED_MAX (DB xuống kéo dài qua ≥3 chu kỳ flush)', `label=${e.label}`)
        if (e.wait) e.reject?.(new BatchDroppedError(e.label, 'bound RETAINED_MAX tràn — batch chứa op này bị drop'))
      }
    }
  }
  if (state.queue.length > 0) scheduleFlush()
}

/**
 * 1 lần thử flush 1 batch — 2 pha (P0-2). Trả true nếu batch ĐÃ commit (đủ
 * hoặc salvage xong); false nếu còn mối nguy (để caller quyết retain).
 */
async function tryBatch(batch: QueuedEntry[]): Promise<boolean> {
  const t0 = Date.now()
  // --- Coalesce tại flush (chỉ SetOp khai idempotencyKey; last-wins — set semantics) ---
  const kept: QueuedEntry[] = []
  const coalesced: QueuedEntry[] = []
  const lastByKey = new Map<string, number>()
  for (let i = 0; i < batch.length; i++) {
    const e = batch[i]
    if (e.op.kind !== 'raw' && e.op.idempotencyKey) {
      lastByKey.set(e.op.idempotencyKey, i) // giữ lại vị trí SAU cùng cùng key
    }
  }
  if (lastByKey.size === 0) {
    kept.push(...batch)
  } else {
    const dropIdx = new Set<number>()
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i]
      if (e.op.kind !== 'raw' && e.op.idempotencyKey) {
        const last = lastByKey.get(e.op.idempotencyKey) as number
        if (last !== i) {
          dropIdx.add(i)
          coalesced.push(e) // op TRƯỚC cùng key — write của nó được đại diện bởi op SAU (set semantics)
          continue
        }
      }
      kept.push(e)
    }
    if (coalesced.length > 0) state.stats.coalescedOps += coalesced.length
  }

  // --- Pha 1: batch tx qua withSqliteRetry (chủ sở hữu retry — P1-2) ---
  let phase1Err: unknown = null
  try {
    await withSqliteRetry(
      () => db.$transaction(
        async tx => {
          for (const e of kept) await applyOp(tx, e.op)
        },
        { timeout: TX_TIMEOUT_MS },
      ),
      { label: `WriteBatcher.phase1(${kept.length} ops)`, retries: 2, baseDelayMs: 300 },
    )
  } catch (err) {
    phase1Err = err
    state.stats.retryCount += 1
  }

  if (phase1Err === null) {
    settleSuccess(kept, coalesced, t0)
    return true
  }

  // --- Pha 2: per-op salvage (P0-2) — không giữ batch chờ flush kế theo kiểu v0.1 ---
  const errLine = firstErrLine(phase1Err)
  console.warn(`[WriteBatcher] Pha 1 fail (${isTransientSqliteError(phase1Err) ? 'transient hết retry' : 'non-transient'}) → salvage per-op: ${errLine}`)
  state.stats.salvageSplits += 1
  const stillFailing: QueuedEntry[] = []
  let poison = 0
  for (const e of kept) {
    try {
      await withSqliteRetry(() => applyOp(db, e.op), { label: `WriteBatcher.salvage(${e.label})`, retries: 2, baseDelayMs: 300 })
      settleOne(e) // op lành qua salvage — waiter resolve
    } catch (opErr) {
      if (isTransientSqliteError(opErr)) {
        stillFailing.push(e) // DB còn contention — giữ lại (đi vào retained của caller)
      } else {
        poison += 1
        console.error(`[WriteBatcher] Poison op "${e.label}" — loại khỏi batch (không chặn op lành): ${firstErrLine(opErr)}`)
        void debtLostOp(e.label, `poison op (lỗi cấu trúc, không phải contention): ${firstErrLine(opErr)}`, `label=${e.label}; batch=${kept.length} ops`)
        if (e.wait) e.reject?.(opErr) // lỗi THẬT của op — waiter nhận nguyên trạng (không phải drop)
      }
    }
  }
  for (const e of coalesced) {
    // Op bị coalesce: write của nó được đại diện bởi op sau cùng key. Nếu op
    // sau cùng key poison/still-failing thì op bị coalesce cũng theo số phận
    // đó — resolve an toàn cho waiter khi SUCCESS; khi fail, đợi chu kỳ sau
    // (không reject riêng để tránh double-settle).
    void e
  }
  settleCoalescedFail(coalesced)
  if (poison > 0) state.stats.poisonCount += poison
  const committedAll = stillFailing.length === 0 && poison === 0
  if (committedAll) {
    // Salvage thành công toàn bộ (phase1 fail nhưng phase2 xong) — coi như commit
    state.stats.flushedBatches += 1
    state.stats.flushedOps += kept.length
    state.stats.lastFlushMs = Date.now() - t0
    state.stats.lastHoldMs = state.stats.lastFlushMs
    flushMsRing.push(state.stats.lastFlushMs)
    if (flushMsRing.length > 50) flushMsRing.shift()
    return true
  }
  if (stillFailing.length > 0) {
    // vẫn còn contention — caller sẽ retain; coalesced của phần này giữ nguyên
    return false
  }
  return true // mọi thứ đã xử xong (poison đã debt/reject, còn lại đã commit)
}

function settleSuccess(kept: QueuedEntry[], coalesced: QueuedEntry[], t0: number): void {
  for (const e of kept) settleOne(e)
  for (const e of coalesced) settleOne(e) // write của coalesced được đại diện bởi op sau (set semantics)
  const flushMs = Date.now() - t0
  state.stats.flushedBatches += 1
  state.stats.flushedOps += kept.length
  state.stats.lastBatchSize = kept.length + coalesced.length
  state.stats.lastFlushMs = flushMs
  state.stats.lastHoldMs = flushMs
  flushMsRing.push(flushMs)
  if (flushMsRing.length > 50) flushMsRing.shift()
  // Hold-time autosplit (P1-5): vượt target → halve chunk; rỗi rãi → double lại (min 25 / max MAX_OPS)
  if (flushMs > HOLD_TARGET_MS) {
    const next = Math.max(25, Math.floor(state.chunkSize / 2))
    if (next !== state.chunkSize) {
      console.warn(`[WriteBatcher] holdMs ${flushMs}ms > target ${HOLD_TARGET_MS}ms — chunk ${state.chunkSize}→${next} (P1-5: không giữ write-lock dài block claim/heartbeat)`)
      state.chunkSize = next
    }
  } else if (flushMs < HOLD_TARGET_MS / 2 && state.chunkSize < MAX_OPS) {
    state.chunkSize = Math.min(MAX_OPS, state.chunkSize * 2)
  }
}
function settleOne(e: QueuedEntry): void {
  if (e.wait) e.resolve?.()
}
function settleCoalescedFail(coalesced: QueuedEntry[]): void {
  // Coalesced mà op đại diện fail: giữ waiter chờ chu kỳ retained kế — nếu
  // cuối cùng bị drop, BatchDroppedError của batch đó sẽ chạm waiter (P1-1).
  void coalesced
}

// ==================== API MỞ (call-site dùng) ====================
export function isWriteQueueEnabled(): boolean {
  return queueEnabled()
}

/** Đưa 1 op vào hàng đợi; resolve khi op nằm trong batch flush THÀNH CÔNG. */
export function enqueueWrite(op: WriteOp, opts: EnqueueOpts = {}): Promise<void> {
  const label = opts.label || (op.kind === 'raw' ? op.label || 'raw' : `${op.model}.${op.kind}`)
  if (op.kind !== 'raw') assertSetSemantics(op, label) // TypeError tại enqueue (P0-3)
  if (!queueEnabled()) {
    // Pass-through — identical hôm nay: withSqliteRetry quanh op đơn (P1-2)
    return withSqliteRetry(() => applyOp(db, op), { label }).then(() => undefined)
  }
  return new Promise<void>((resolve, reject) => {
    state.queue.push({ op, label, wait: true, resolve, reject })
    if (state.queue.length >= MAX_OPS) {
      // Depth trigger — flush sớm qua chuỗi nối tiếp (không đợi timer)
      void runFlush().catch(() => { /* flushOnce tự nuốt */ })
    } else {
      scheduleFlush()
    }
  })
}

/** Fire-and-forget — KHÔNG throw; fail → debt + DEVLOG (đường phi-critical). */
export function enqueueWriteFireAndForget(op: WriteOp, opts: EnqueueOpts = {}): void {
  const label = opts.label || (op.kind === 'raw' ? op.label || 'raw' : `${op.model}.${op.kind}`)
  if (op.kind !== 'raw') {
    try {
      assertSetSemantics(op, label)
    } catch (err) {
      // TypeError tại enqueue là lỗi LAP TRÌNH (call-site vi phạm hợp đồng) —
      // fire-and-forget vẫn phải lên tiếng, không nuốt im lặng.
      console.error(`[WriteBatcher] ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }
  if (!queueEnabled()) {
    void withSqliteRetry(() => applyOp(db, op), { label })
      .catch(err => {
        // Delta duy nhất của off-mode (ghi chú fixbug W1): 1 dòng warn —
        // log-only, KHÔNG thêm DB write; fail-open giữ nguyên (không throw).
        console.warn(`[WriteBatcher] direct "${label}" fail (pass-through, fail-open): ${firstErrLine(err)}`)
      })
    return
  }
  state.queue.push({ op, label, wait: false })
  if (state.queue.length >= MAX_OPS) {
    void runFlush().catch(() => { /* flushOnce tự nuốt */ })
  } else {
    scheduleFlush()
  }
}

/**
 * Trigger 3 (P0-1.1) — flush NGAY toàn bộ queue đang chờ (gọi tại
 * run-close/finalize — đúng nơi burst + crash tập trung). Không throw.
 */
export function flushWriteQueueNow(): Promise<void> {
  if (!queueEnabled()) return Promise.resolve()
  if (state.queue.length === 0 && state.retained.length === 0) return Promise.resolve()
  return runFlush().then(() => undefined, () => undefined)
}

/**
 * Trigger 4 (P0-1.2) — drain có bound cho selfExitWithDrain. KHÔNG đè hợp đồng
 * 600ms response-drain: caller chờ max(600ms, drain) nhưng ≤ boundMs.
 */
export async function drainWriteQueueForExit(boundMs: number): Promise<{ flushedOps: number; pendingLeft: number }> {
  if (!queueEnabled()) return { flushedOps: 0, pendingLeft: 0 }
  const deadline = Date.now() + Math.max(200, boundMs)
  let rounds = 0
  while ((state.queue.length > 0 || state.retained.length > 0) && Date.now() < deadline && rounds < 10) {
    rounds += 1
    await runFlush().catch(() => undefined)
    if (state.queue.length === 0 && state.retained.length === 0) break
    // còn sót (DB down thật) — chờ 1 nhịp rồi thử lại trong bound
    await new Promise(r => setTimeout(r, 250))
  }
  const pendingLeft = state.queue.length + state.retained.reduce((n, b) => n + b.length, 0)
  if (pendingLeft > 0) {
    // Đến đây là mất thật (at-most-once-on-SIGKILL window đã hở) — debt gộp
    void debtLostOp(
      'shutdown-drain',
      `drain exit không xong trong ${boundMs}ms — ${pendingLeft} ops còn kẹt (DB xuống lúc process chuẩn bị exit)`,
      `pending=${pendingLeft}; boundMs=${boundMs}`,
    )
  }
  return { flushedOps: state.stats.flushedOps, pendingLeft }
}

export function getWriteQueueStats(): WriteQueueStats {
  return {
    enabled: queueEnabled(),
    queueDepth: state.queue.length,
    retainedBatches: state.retained.length,
    flushing: state.flushing,
    lastBatchSize: state.stats.lastBatchSize,
    lastFlushMs: state.stats.lastFlushMs,
    lastHoldMs: state.stats.lastHoldMs,
    chunkSize: state.chunkSize,
    flushP95Ms: p95FromRing(),
    flushedBatches: state.stats.flushedBatches,
    flushedOps: state.stats.flushedOps,
    coalescedOps: state.stats.coalescedOps,
    dropCount: state.stats.dropCount,
    retryCount: state.stats.retryCount,
    salvageSplits: state.stats.salvageSplits,
    poisonCount: state.stats.poisonCount,
  }
}
