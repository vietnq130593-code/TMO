/**
 * scripts/worker.ts — W2/S3 (BLUEPRINT-R17BC v0.2) — PROCESS WORKER RIÊNG cho goal-loop
 * =====================================================================================
 * Tách worker khỏi process API (pm2 app `theopus-worker`, app thứ 3 trong
 * ecosystem.config.cjs). DB LÀ BUS DUY NHẤT — 0 IPC mới (claim/mutex/checkpoint/
 * heartbeat/RESUME đã DB-durable từ R18). Hiệu ứng cách ly (KPI #4 — REVIEW-1
 * P0-4): API restart KHÔNG giết job đang chạy trong worker; worker restart
 * KHÔNG chạm API.
 *
 * Boot chain mirror instrumentation-node.ts:1278-1286 (inline mode):
 *   ensureDbReady → recoverPending() → start()
 *
 * Chế độ (đọc từ .env — CÙNG nguồn sự thật với process API; Next tự nạp .env
 * lúc boot, file này parse .env trực tiếp qua src/lib/worker-env.ts —
 * FB-W2-R1-01: helper v1 trả '' cho key vắng làm `?? DEFAULT` chết
 * (Number('')=0 → ngưỡng rơi floor 300MB/30s trên worker thật); v2 nullish
 * + chặn NaN — regression behavioral r139 nhóm E):
 *   GOAL_LOOP_WORKER_MODE=inline (mặc định) → SHADOW: process này KHÔNG claim
 *     (worker chạy trong process API như hôm nay). Giữ process sống làm điểm
 *     neo heart-thread; đổi mode=split + restart để kích hoạt.
 *   GOAL_LOOP_WORKER_MODE=split → worker process NÀY lo recoverPending + start;
 *     process API sẽ KHÔNG start worker (instrumentation-node glwMode gate).
 *
 * Watchdog riêng của worker (không mở port — KHÔNG HttpWatchdog):
 *   - MemWatchdog nhẹ: WORKER_MEM_WATCHDOG_MB (default 1000) × 2 checks 30s
 *     → self-exit sạch; pm2 backstop max_memory_restart.
 *   - Heart-movement (P1-3): worker_threads scripts/worker-heart-thread.ts —
 *     ping/pong 15s; không pong ≥ WORKER_HEART_MOVEMENT_MS (120s) → exit(1).
 *
 * processRole (S4): env TMO_PROCESS_ROLE=worker đặt TRƯỚC mọi import — mọi
 * observation event từ process này mang processRole='worker' (ledger writeOne).
 */
process.env.TMO_PROCESS_ROLE = 'worker'

import os from 'node:os'
import { Worker } from 'node:worker_threads'
// FB-W2-R1-01: helper env tách module không side-effect (script boot không
// import được trong test — behavioral regression sống ở r139 nhóm E).
import { findProjectRoot, readEnvFileKey, readNumEnv } from '../src/lib/worker-env'

const ROOT = findProjectRoot()
const MODE = (process.env.GOAL_LOOP_WORKER_MODE || readEnvFileKey(ROOT, 'GOAL_LOOP_WORKER_MODE') || 'inline').trim().toLowerCase()
const WORKER_MEM_WATCHDOG_MB = readNumEnv(ROOT, 'WORKER_MEM_WATCHDOG_MB', 1000, 300)
const HEART_MOVEMENT_MS = readNumEnv(ROOT, 'WORKER_HEART_MOVEMENT_MS', 120_000, 30_000)
const MEM_CHECK_INTERVAL_MS = readNumEnv(ROOT, 'WORKER_MEM_CHECK_INTERVAL_MS', 30_000, 10_000)

// ==================== Heart-movement thread (P1-3) ====================
let heartThread: Worker | null = null
function startHeartThread(): void {
  try {
    heartThread = new Worker(new URL('./worker-heart-thread.ts', import.meta.url))
    // FB-W2-R1-02 (dọn viết-chưa-đọc): bỏ biến lastPongAt write-only + nhánh
    // 'pong' chết (thread không bao giờ GỬI pong — chỉ main gửi; thread tự
    // theo dõi lastPong và tự exit khi im lặng). Main chỉ việc trả pong.
    heartThread.on('message', (m: unknown) => {
      if (m === 'ping') heartThread?.postMessage('pong')
    })
    heartThread.on('error', err => {
      // Thread chết không được giết main — main vẫn sống; LOG + thử lại 1 lần sau 30s
      console.warn('[theopus-worker] heart-thread lỗi (thử lại sau 30s):', err instanceof Error ? err.message : String(err))
      setTimeout(() => startHeartThread(), 30_000)
    })
    console.log(`[theopus-worker] Heart-movement thread bật — ping/pong, ngưỡng ${Math.round(HEART_MOVEMENT_MS / 1000)}s (WORKER_HEART_MOVEMENT_MS; thread vòng sự kiện riêng — thấy được event loop kẹt mà in-process timer không bao giờ thấy)`)
  } catch (err) {
    console.warn('[theopus-worker] worker_threads không khả dụng — heart-movement degraded (bỏ qua, không chặn boot):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== MemWatchdog nhẹ của worker ====================
let memBreachCount = 0
function startMemWatchdog(): void {
  setInterval(() => {
    const rss = process.memoryUsage().rss / (1024 * 1024)
    const availMb = (os.freemem() / (1024 * 1024))
    if (rss >= WORKER_MEM_WATCHDOG_MB && availMb < 900) {
      memBreachCount += 1
      if (memBreachCount >= 2) {
        console.error(`[theopus-worker] MemWatchdog: RSS ${Math.round(rss)}MB ≥ ${WORKER_MEM_WATCHDOG_MB}MB × 2 checks (avail ${Math.round(availMb)}MB) → self-exit sạch cho pm2 restart (goal jobs RESUME từ checkpoint — R18 durable)`)
        process.exit(1)
      }
    } else {
      memBreachCount = 0
    }
  }, MEM_CHECK_INTERVAL_MS).unref?.()
  console.log(`[theopus-worker] MemWatchdog bật — ngưỡng RSS ${WORKER_MEM_WATCHDOG_MB}MB × 2 checks ${Math.round(MEM_CHECK_INTERVAL_MS / 1000)}s (avail-aware <900MB); pm2 backstop max_memory_restart`)
}

// ==================== Boot ====================
async function main(): Promise<void> {
  console.log(`[theopus-worker] boot — mode=${MODE} (pid ${process.pid})`)
  startHeartThread()
  startMemWatchdog()

  if (MODE !== 'split') {
    console.log(
      '[theopus-worker] SHADOW MODE (inline mặc định): process này KHÔNG claim/mutex/tick — worker chạy trong process API như hôm nay. Giữ process làm điểm neo heart-thread; đổi GOAL_LOOP_WORKER_MODE=split trong .env + pm2 restart theopus-worker để kích hoạt (process API cũng cần restart để đọc cùng mode — ĐÚNG 2process 1 nguồn sự thật .env).'
    )
    return
  }

  // FB-W2-R3-01 (pilot 2026-10-20 — phát hiện bằng /proc/<pid>/environ):
  // `pm2 restart --update-env` tiêm env của SHELL hiện hành vào process —
  // shell sandbox có DATABASE_URL=file:/home/z/my-project/db/custom.db (DB
  // scaffold, KHÔNG phải TMO) → worker nối NHẦM DB rỗng: sweep thấy 0 job,
  // claim im lặng mãi, "requeue 0" mọi boot. Process worker lấy .env của
  // TMO làm NGUỒN SỰ THẬT DUY NHẤT — env ngoài (pm2/shell) không được phép
  // chuyển hướng DB. Chặn TẠI BOOT, TRƯỚC khi import db-setup (db.ts đọc
  // env lúc module-load).
  const envFileDb = readEnvFileKey(ROOT, 'DATABASE_URL')
  if (envFileDb && process.env.DATABASE_URL !== envFileDb) {
    console.warn(
      `[theopus-worker] DATABASE_URL env ngoài (${process.env.DATABASE_URL ?? '(không đặt)'} KHÁC .env (${envFileDb})) — CHỐNG TIÊM NHẦM (pm2 --update-env tiêm env shell; pilot 2026-10-20: worker từng nối nhầm DB scaffold my-project) → worker dùng .env của TMO.`
    )
    process.env.DATABASE_URL = envFileDb
  }

  const { ensureDbReady } = await import('../src/lib/db-setup')
  await ensureDbReady()
  const { goalLoopWorker } = await import('../src/lib/goal-loop-worker')
  const { requeued, markedFailed } = await goalLoopWorker.recoverPending()
  console.log(
    `[theopus-worker] boot recovery (split): ${requeued} job requeue (RESUME từ checkpoint), ${markedFailed} job mark failed (vượt max-attempts)`
  )
  goalLoopWorker.start()
  console.log('[theopus-worker] STARTED (split) — tick claim/mutex/checkpoint/RESUME; DB là bus, 0 IPC (R18 durable). Process API sẽ KHÔNG start worker (glwMode gate instrumentation-node).'
  )
  // KPI #3/#9 đo được Ở PROCESS WORKER (split: job chạy đây — route
  // /api/observation/write-queue chỉ thấy stats process API): log stats
  // write-queue chu kỳ 1 dòng JSON (flushP95Ms/dropCount/salvageSplits/
  // poisonCount) — không mở port, nguyên tắc 0 IPC giữ nguyên.
  // KPI #2 (trả nợ 2026-10-21 — FB-DEBT4): log THÊM interactive-tx stats
  // (p95 ledger/trace writeOne — job chạy trong process này) cùng nhịp —
  // route /api/observation/interactive-tx chỉ thấy process API.
  const [{ getWriteQueueStats }, { getInteractiveTxStats }] = await Promise.all([
    import('../src/lib/db-write-batcher'),
    import('../src/lib/observation/tx-stats'),
  ])
  const statsEveryMs = readNumEnv(ROOT, 'WORKER_STATS_LOG_MS', 300_000, 60_000)
  setInterval(() => {
    try {
      console.log('[theopus-worker] write-queue stats', JSON.stringify(getWriteQueueStats()))
      const tx = getInteractiveTxStats()
      if (tx.labels.length > 0) {
        console.log('[theopus-worker] interactive-tx stats (KPI #2)', JSON.stringify(tx))
      }
    } catch { /* fail-open — stats là đo lường, không được phá process */ }
  }, statsEveryMs).unref?.()
}

void main().catch(err => {
  console.error('[theopus-worker] boot lỗi — self-exit cho pm2 restart:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
