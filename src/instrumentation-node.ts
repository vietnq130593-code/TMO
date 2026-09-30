/**
 * Instrumentation — Node.js runtime only
 *
 * Loaded via dynamic import() from ./instrumentation.ts, so it is never
 * bundled for the Edge runtime. Safe to use Node-only APIs here.
 *
 * Starts the 3 mini-services (openclaw-gateway, opencode-server,
 * gateway-bridge) in the background WITHOUT blocking the Next.js server
 * from accepting requests. The app degrades gracefully when any service is
 * unavailable.
 */

import { startAllServices, type ServiceConfig } from './lib/service-manager'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { ensureTmoApiToken } from './lib/tmo-token'
import { isOnDemandEnabled, initOnDemandWatchdog } from './lib/openclaw-ondemand'
// DB SELF-HEALING (fix user report 2026-09-09 "local không load agents"):
// user pull code mới có thay đổi schema (cột/bảng mới) nhưng chưa chạy
// `bun run db:push` trên local → Prisma client mới query DB cũ → mọi API
// agents lỗi P2021/P2022 → UI hiện danh sách TRỐNG. ensureDbReady() probe
// drift và tự chạy `prisma db push` — KHÔNG chặn boot (fire-and-forget);
// warm-up bên dưới await nó trước khi prefetch /api/agents.
import { ensureDbReady } from './lib/db-setup'

// FIX 2026-08-28: đảm bảo TMO_API_TOKEN tồn tại TRƯỚC KHI spawn mini-services.
// opencode-server validate X-TMO-API-Token trên MỌI request (kể cả /health) —
// thiếu token → 503 + health check fail → kill/restart loop. Token được resolve
// đồng bộ (env ưu tiên, fallback tự sinh + persist file .tmo-api-token) và
// gán vào process.env để các child process (mini-services) inherit.
try {
  const token = ensureTmoApiToken()
  console.log(
    token
      ? '[instrumentation] TMO_API_TOKEN ready'
      : '[instrumentation] WARNING: TMO_API_TOKEN unavailable (env + file provisioning failed) — mini-services may 503'
  )
} catch (err) {
  console.error('[instrumentation] ensureTmoApiToken failed:', err)
}

// ============================================================================
// MEM WATCHDOG (2026-09-28 — quan sát vận hành thật: 2 lần kernel OOM-killer
// SIGKILL next-server giữa chừng agent run, 23:08 RSS 2.46GB + 23:23 RSS
// 1.44GB, memcg 4GB cạn tổng thể — nhiệm vụ agent 15 phút chết sạch, user
// message không có câu trả lời). [Cập nhật 2026-09-30 vòng 9: nhận thức cũ
// "PM2 max_memory_restart đo pid wrapper nên bất lực" đã LỖI THỜI từ khi
// pm2-start.sh dùng exec — PM2 giờ đo TRỰC TIẾP RSS node; cấu hình mới đặt
// PM2 1800M CAO hơn ngưỡng watchdog bên dưới để đường graceful self-exit
// LUÔN thắng cuộc đua — xem ecosystem.config.cjs.] Watchdog này chạy NGAY
// TRONG next-server (instrumentation load ở đó): RSS vượt ngưỡng
// MEM_WATCHDOG_MB (mặc định 1700) trong 2 lần kiểm tra liên tiếp (60s) →
// log rõ + process.exit(1) — PM2 restart sạch trong ~5s (SQLite WAL bền,
// mini-services được service-manager dọn + respawn, durable goal-loop jobs
// RESUME từ checkpoint). Đổi tự sát có kiểm soát còn hơn kernel SIGKILL cả
// cây tiến trình không báo trước (có thể chọn nhầm nạn nhân khác).
// Tắt hẳn: MEM_WATCHDOG_MB=0.
// ============================================================================
const globalForMemWatchdog = globalThis as unknown as { __tmoMemWatchdogStarted?: boolean }
if (!globalForMemWatchdog.__tmoMemWatchdogStarted) {
  globalForMemWatchdog.__tmoMemWatchdogStarted = true
  const MEM_WATCHDOG_MB = Number(process.env.MEM_WATCHDOG_MB ?? 1700)
  // ROUND-11 (11:46:31 kernel GLOBAL OOM giết next-server RSS 1.96GB): cadence
  // kiểm tra 60s cũ cho kernel cửa sổ đua trống giữa 2 lần check khi RSS tăng
  // nhanh (~1GB/phút lúc cold-boot recompile + mission resume). Interval giờ
  // env-tunable (MEM_WATCHDOG_INTERVAL_MS, mặc định 60s giữ hành vi cũ) — cấu
  // hình production hiện 30s: phát hiện vượt ngưỡng sớm gấp đôi, global guard
  // MemAvailable cũng đập mỗi 30s thay vì 60s.
  const MEM_WATCHDOG_INTERVAL_MS = Math.max(10_000, Number(process.env.MEM_WATCHDOG_INTERVAL_MS ?? 60_000))
  // ROUND-11b — RSS trigger avail-aware: ngưỡng available mà DƯỚI đó box bị
  // coi là chật (khi đó RSS vượt ngưỡng MỚI tính là vượt thật). Mặc định 900MB
  // = trên global-guard 650MB (tier sớm) — kernel chỉ OOM khi available cạn,
  // không phải khi RSS to.
  const MEM_WATCHDOG_RSS_EXIT_AVAIL_MB = Number(process.env.MEM_WATCHDOG_RSS_EXIT_AVAIL_MB ?? 900)
  // ROUND-3 FIX (2026-09-29 — quan sát vận hành vòng 3): kernel OOM-killer còn
  // xuống tay TRƯỚC khi RSS chạm ngưỡng — bằng chứng dmesg 07:2x: next-server
  // bị kill ở RSS ~1.1GB (dưới ngưỡng 1700) vì V8Worker/turbopack invoke
  // oom-killer khi MEM TOÀN CỤC cạn (box 4GB: goal-loop + embed + turbopack +
  // mini-services cùng chạy). Chỉ đo RSS bản thân là không đủ — theo dõi thêm
  // MemAvailable toàn cục (/proc/meminfo): cạn THẬT (dưới
  // MEM_WATCHDOG_GLOBAL_MIN_MB, mặc định 450MB) VÀ next-server đang là consumer
  // lớn (RSS > MEM_WATCHDOG_GLOBAL_RSS_MB, mặc định 900MB) → self-exit NGAY ở
  // lần kiểm tra đầu (không chờ 2 phút — kernel SIGKILL không báo trước và có
  // thể chọn nhầm nạn nhân khác trong cây). RSS nhỏ mà MemAvailable thấp →
  // thủ phạm là process khác, next-server chết cũng không giải phóng đủ —
  // KHÔNG tự sát (tránh PM2 restart-loop oan).
  const MEM_WATCHDOG_GLOBAL_MIN_MB = Number(process.env.MEM_WATCHDOG_GLOBAL_MIN_MB ?? 450)
  const MEM_WATCHDOG_GLOBAL_RSS_MB = Number(process.env.MEM_WATCHDOG_GLOBAL_RSS_MB ?? 900)
  if (MEM_WATCHDOG_MB > 0) {
    const readMemAvailableMb = (): number | null => {
      try {
        const s = readFileSync('/proc/meminfo', 'utf8')
        const m = /MemAvailable:\s+(\d+)\s*kB/.exec(s)
        return m ? Math.round(parseInt(m[1], 10) / 1024) : null
      } catch { return null }
    }
    let memOverCount = 0
    // ROUND-9 (2026-09-30): cảnh báo tiệm cận 1 lần/lần-chạy — quan sát vòng 9
    // thấy các lần restart RSS đều KHÔNG có dấu hiệu báo trước trong log (PM2
    // giết im lặng). Log 1 dòng khi RSS vào vùng 200MB dưới ngưỡng để lượt
    // quan sát sau biết đường graceful sắp kích hoạt.
    let memNearWarned = false
    const memWatchdogTimer = setInterval(() => {
      try {
        const rssMb = process.memoryUsage().rss / 1048576
        if (!memNearWarned && rssMb > MEM_WATCHDOG_MB - 200) {
          memNearWarned = true
          console.warn(`[MemWatchdog] RSS ${rssMb.toFixed(0)}MB tiệm cận ngưỡng ${MEM_WATCHDOG_MB}MB (còn ${Math.max(0, Math.round(MEM_WATCHDOG_MB - rssMb))}MB) — vượt ngưỡng 2 lần kiểm tra liên tiếp sẽ self-exit graceful; PM2 max_memory_restart (3200M — vòng 11) là backstop phía sau`)
        }
        // Global-memory guard — ROUND-3 FIX
        if (MEM_WATCHDOG_GLOBAL_MIN_MB > 0 && rssMb > MEM_WATCHDOG_GLOBAL_RSS_MB) {
          const availMb = readMemAvailableMb()
          if (availMb !== null && availMb < MEM_WATCHDOG_GLOBAL_MIN_MB) {
            console.error(`[MemWatchdog] MemAvailable toàn cục ${availMb}MB < ${MEM_WATCHDOG_GLOBAL_MIN_MB}MB (RSS mình ${rssMb.toFixed(0)}MB > ${MEM_WATCHDOG_GLOBAL_RSS_MB}MB) — bộ nhớ HỆ THỐNG cạn, kernel OOM sắp xuống tay — self-exit NGAY để chết có kiểm soát (PM2 restart ~5s; durable goal jobs RESUME từ checkpoint)`)
            process.exit(1)
          }
        }
        if (rssMb > MEM_WATCHDOG_MB) {
          memOverCount++
          // ROUND-11b (12:0x — sửa restart-loop do chính round-11 gây ra):
          // app cold-boot + mission resume ổn định ở 2.1-2.2GB với box 4GB vẫn
          // còn ~2.3GB available — RSS cao MỘT MÌNH chưa nguy hiểm (kernel chỉ
          // OOM khi MemAvailable cạn). RSS trigger giờ AVAIL-AWARE: chỉ tính
          // là "vượt ngưỡng thật sự" khi BOX cũng chật (MemAvailable <
          // MEM_WATCHDOG_RSS_EXIT_AVAIL_MB); box còn dư → log theo dõi, GIỮ
          // đếm (không reset — nếu avail cạn về sau sẽ exit ngay check kế).
          const availMb = readMemAvailableMb()
          const boxTight = availMb !== null && availMb < MEM_WATCHDOG_RSS_EXIT_AVAIL_MB
          if (boxTight) {
            console.warn(`[MemWatchdog] RSS ${rssMb.toFixed(0)}MB > ${MEM_WATCHDOG_MB}MB (lần ${memOverCount}/2) VÀ MemAvailable ${availMb}MB < ${MEM_WATCHDOG_RSS_EXIT_AVAIL_MB}MB — box chật thật`)
          } else {
            console.warn(`[MemWatchdog] RSS ${rssMb.toFixed(0)}MB > ${MEM_WATCHDOG_MB}MB (lần ${memOverCount}/2) NHƯNG MemAvailable ${availMb ?? '?'}MB còn dư — RSS cao một mình chưa nguy hiểm, theo dõi tiếp (không self-exit)`)
            memOverCount = 1 // giữ 1 nhịp "đã thấy vượt" — exit cần box chật ở check kế
          }
        } else {
          if (memOverCount > 0) console.log(`[MemWatchdog] RSS hồi về ${rssMb.toFixed(0)}MB — reset đếm`)
          memOverCount = 0
        }
        if (memOverCount >= 2) {
          console.error(`[MemWatchdog] RSS ${rssMb.toFixed(0)}MB vượt ${MEM_WATCHDOG_MB}MB suốt 2 lần kiểm tra (${Math.round(MEM_WATCHDOG_INTERVAL_MS / 1000)}s × 2) VÀ box chật (MemAvailable < ${MEM_WATCHDOG_RSS_EXIT_AVAIL_MB}MB) — self-exit sạch để kernel OOM không SIGKILL cả cây (PM2 sẽ restart trong ~5s; durable goal jobs RESUME từ checkpoint)`)
          process.exit(1)
        }
      } catch { /* fail-open — watchdog lỗi không được phép tự giết app */ }
    }, MEM_WATCHDOG_INTERVAL_MS)
    memWatchdogTimer.unref?.()
    console.log(`[MemWatchdog] bật — ngưỡng RSS ${MEM_WATCHDOG_MB}MB × 2 lần kiểm tra (${Math.round(MEM_WATCHDOG_INTERVAL_MS / 1000)}s/lần, avail-aware: chỉ exit khi MemAvailable<${MEM_WATCHDOG_RSS_EXIT_AVAIL_MB}MB) + global guard MemAvailable<${MEM_WATCHDOG_GLOBAL_MIN_MB}MB khi RSS>${MEM_WATCHDOG_GLOBAL_RSS_MB}MB (exit ngay)`)
  }
}

// ============================================================================
// HTTP WEDGE WATCHDOG (round-4 2026-09-29 — quan sát vận hành vòng 4): dev
// server (Turbopack) bị WEDGE HTTP intake: accept backlog 23 connection chờ
// KHÔNG được accept, event loop vẫn chạy (goal-loop LLM hoạt động), RSS bình
// thường (MemWatchdog không phát hiện) — mọi request ngoài (kể cả trang chủ
// "/" — bề mặt duy nhất user thấy) treo vĩnh viễn. Chỉ PM2 restart mới giải
// phóng. Watchdog này tự probe loopback mỗi 60s: timeout/lỗi kết nối 3 LẦN
// LIÊN TIẾP (sau khi đã từng thành công ít nhất 1 lần — bỏ qua cửa sổ boot
// ~3 phút đầu) → self-exit(1) để PM2 restart sạch, durable goal jobs RESUME
// từ checkpoint. CHỈ đếm lỗi transport (timeout/ECONNRESET/abort) — HTTP
// 4xx/5xx nghĩa là intake VẪN SỐNG (lỗi app khác, không restart-loop oan).
// Tắt hẳn: HTTP_WATCHDOG=0.
// ============================================================================
const globalForHttpWatchdog = globalThis as unknown as { __tmoHttpWatchdogStarted?: boolean }
if (!globalForHttpWatchdog.__tmoHttpWatchdogStarted) {
  globalForHttpWatchdog.__tmoHttpWatchdogStarted = true
  const HTTP_WATCHDOG = (process.env.HTTP_WATCHDOG ?? '1') !== '0'
  const HTTP_PROBE_URL = `http://127.0.0.1:${process.env.PORT ?? '3000'}/api/goal-loop-jobs`
  if (HTTP_WATCHDOG) {
    let httpFailCount = 0
    let httpEverSucceeded = false
    const httpWatchdogTimer = setInterval(async () => {
      try {
        // Cửa sổ boot: 150s đầu dev server đang compile — bỏ qua
        if (process.uptime() < 150) return
        // fetch tự thanh công? timeout 15s — request nhẹ (~10ms) nhưng
        // qualify 15s để không tính oan lúc compile burst route lần đầu.
        const res = await fetch(HTTP_PROBE_URL, { signal: AbortSignal.timeout(15_000) })
        // Được response (bất kể status) → intake sống
        httpFailCount = 0
        if (!httpEverSucceeded) {
          httpEverSucceeded = true
          console.log(`[HttpWatchdog] probe đầu tiên OK (status ${res.status}) — đã bật lưng canh wedge`)
        }
      } catch {
        // Chỉ đếm khi ĐÃ TỪNG thành công (chống giết oan lúc boot chậm/compile
        // burst chưa từng xong) — lỗi transport = timeout/abort/reset.
        if (!httpEverSucceeded) return
        httpFailCount++
        console.warn(`[HttpWatchdog] probe loopback thất bại (lần ${httpFailCount}/3) — HTTP intake nghi wedge: ${HTTP_PROBE_URL}`)
        if (httpFailCount >= 3) {
          console.error(`[HttpWatchdog] HTTP intake WEDGE xác nhận — 3 probe liên tiếp không response trong khi process sống. Self-exit để PM2 restart sạch (durable goal jobs RESUME từ checkpoint).`)
          process.exit(1)
        }
      }
    }, 60_000)
    httpWatchdogTimer.unref?.()
    console.log(`[HttpWatchdog] bật — probe ${HTTP_PROBE_URL} mỗi 60s, 3 fail liên tiếp (sau lần đầu OK) → self-exit`)
  }
}

function buildServices(resolveFn: (...paths: string[]) => string) {
  const ROOT = resolveFn(process.cwd())
  const services: ServiceConfig[] = [
    {
      name: 'openclaw-gateway',
      cwd: resolve(ROOT, 'mini-services/openclaw-gateway'),
      command: 'bun',
      args: ['index.ts'],
      env: {
        NVIDIA_API_KEY: process.env.NVIDIA_API_KEY_1 || '',
        NVIDIA_API_KEY_1: process.env.NVIDIA_API_KEY_1 || '',
        NVIDIA_API_KEY_2: process.env.NVIDIA_API_KEY_2 || '',
        NVIDIA_API_KEY_3: process.env.NVIDIA_API_KEY_3 || '',
        NVIDIA_API_KEY_4: process.env.NVIDIA_API_KEY_4 || '',
      },
      healthUrl: `http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || '18789'}/health`,
      healthTimeoutMs: 30000,
      healthIntervalMs: 1000,
      maxRetries: 5,
    },
    {
      name: 'opencode-server',
      cwd: resolve(ROOT, 'mini-services/opencode-server'),
      command: 'bun',
      args: ['index.ts'],
      // FIX 2026-09-15 (multi-instance — clone-first workflow): health check
      // theo port env (bản clone chạy app để kiểm định đặt
      // OPENCODE_SERVER_PORT=18791... riêng, không giành port production).
      healthUrl: `http://127.0.0.1:${process.env.OPENCODE_SERVER_PORT || '18790'}/health`,
      healthTimeoutMs: 30000,
      healthIntervalMs: 1000,
      maxRetries: 3,
    },
    {
      name: 'gateway-bridge',
      cwd: resolve(ROOT, 'mini-services/gateway-bridge'),
      command: 'bun',
      args: ['index.ts'],
      healthUrl: `http://127.0.0.1:${process.env.GATEWAY_BRIDGE_PORT || '18791'}/health`,
      healthTimeoutMs: 30000,
      healthIntervalMs: 1000,
      maxRetries: 3,
      dependsOn: 'openclaw-gateway',
    },
    // Phase 4.6 — cron-scheduler mini-service (Z.ai Code parity).
    // Tick loop queries SQLite for due CronJob rows and executes them via
    // /api/openclaw/sessions?action=run (relative path + XTransformPort=3000
    // so Caddy routes correctly). Started in parallel with the other services
    // since it has no upstream dependency.
    {
      name: 'cron-scheduler',
      cwd: resolve(ROOT, 'mini-services/cron-scheduler'),
      command: 'bun',
      args: ['index.ts'],
      env: {
        DATABASE_URL: process.env.DATABASE_URL || '',
        ENABLE_CRON_TOOL: process.env.ENABLE_CRON_TOOL || 'false',
        CRON_AGENT_ENDPOINT: process.env.CRON_AGENT_ENDPOINT || 'http://localhost:3000/api/openclaw/sessions',
        // FIX 2026-09-15 (multi-instance): port env cho clone instance
        CRON_SCHEDULER_PORT: process.env.CRON_SCHEDULER_PORT || '3004',
      },
      healthUrl: `http://127.0.0.1:${process.env.CRON_SCHEDULER_PORT || '3004'}/health`,
      healthTimeoutMs: 30000,
      healthIntervalMs: 1000,
      maxRetries: 3,
    },
  ]

  // ON-DEMAND GATEWAY (user request 2026-09-07): KHÔNG spawn openclaw-gateway
  // + gateway-bridge lúc boot — gateway chỉ chiếm RAM (~340MB idle, có thể lên
  // GB khi có session) mà các luồng chính (agents có provider/model, Code
  // Studio, Code Team, KB) đều KHÔNG đi qua nó. Gateway sẽ được lazy-spawn khi
  // một tính năng thật sự cần (chat fallback, Channels, skills...) qua
  // ensureGatewayRunning() và tự tắt sau idle. Tắt chế độ: OPENCLAW_ON_DEMAND=false
  if (isOnDemandEnabled()) {
    console.log('[instrumentation] OpenClaw gateway: ON-DEMAND mode — không spawn lúc boot; lazy-start khi tính năng cần (OPENCLAW_ON_DEMAND=false để luôn-start như cũ)')
    return services.filter(s => s.name !== 'openclaw-gateway' && s.name !== 'gateway-bridge')
  }
  return services
}

console.log('[instrumentation] Starting mini-services (non-blocking)...')

// DB self-healing — chạy NGAY sau boot (không đợi warm-up): probe schema drift
// và tự `prisma db push` nếu DB local cũ hơn schema (thường xảy ra sau git pull).
// Fire-and-forget: promise này được dedup — warm-up + API agents await lại cùng
// promise, không chạy trùng.
void ensureDbReady().then((r) => {
  if (r.migrated) console.log('[instrumentation] DB schema đã được tự đồng bộ:', r.reason || 'prisma db push')
})

// Fire-and-forget: do NOT await. Keeps the Next.js UI available instantly
// while the services come up asynchronously.
startAllServices(buildServices(resolve))
  .then(() => {
    console.log('[instrumentation] All mini-services started successfully')
  })
  .catch((err) => {
    console.error('[instrumentation] Failed to start some services:', err)
    // Don't block Next.js startup — app can still work with fallback
  })

// ON-DEMAND watchdog: đăng ký idle-shutdown timer + adopt gateway orphan
// còn chạy từ process trước (nếu có) — chỉ khi on-demand mode bật.
if (isOnDemandEnabled()) {
  try {
    initOnDemandWatchdog()
  } catch (err) {
    console.warn('[instrumentation] openclaw-ondemand watchdog init failed:', err)
  }
}

// WARM-UP ROUTES (fix "load danh sách agents lâu sau khi khởi động lại" —
// user report 2026-09-08): trong next dev, route đầu tiên được gọi phải chịu
// chi phí Turbopack compile + Prisma client cold-init + agent seeds. Nếu
// user mở UI ngay sau `bun run dev`, các fetch agents/sessions dồn vào đúng
// lần compile đó. Warm-up chủ động sau boot: (1) đợi server HTTP listen,
// (2) tự gọi /api/agents + /api/agents/models để compile + seed sẵn — khi
// user mở UI thì response gần như tức thì. HOÀN TOÀN fail-open, KHÔNG đụng
// gateway (không spawn on-demand) và không chặn boot.
setTimeout(async () => {
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`
  const warmPaths = ['/api/agents', '/api/agents/models', '/api/openclaw/sessions?action=list']
  try {
    // DB self-heal PHẢI xong trước khi warm /api/agents — nếu không, lần warm
    // đầu tiên đập vào DB cũ, seed agents fail, và (không có retry) sẽ bỏ sót
    // tới request kế tiếp. ensureDbReady dedup với lời gọi ở boot phía trên.
    const dbReady = await Promise.race([
      ensureDbReady(),
      new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: false }), 150_000)),
    ])
    if (!dbReady.ok) {
      console.warn('[instrumentation] DB chưa sẵn sàng sau self-heal — warm-up vẫn tiếp tục (API sẽ tự heal khi có request)')
    }
    // Đợi server listen (tối đa 60s — Windows dev boot chậm)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
        if (res.ok) break
      } catch { /* chưa listen — thử lại */ }
      await new Promise(r => setTimeout(r, 1000))
    }
    const results = await Promise.allSettled(warmPaths.map(p =>
      fetch(`${base}${p}`, { signal: AbortSignal.timeout(30_000) }).then(r => r.status)
    ))
    const ok = results.filter(r => r.status === 'fulfilled' && r.value === 200).length
    console.log(`[instrumentation] Warm-up xong: ${ok}/${warmPaths.length} route sẵn sàng (agents list sẽ load nhanh)`)
  } catch (err) {
    console.warn('[instrumentation] Warm-up skipped:', err instanceof Error ? err.message : String(err))
  }
}, 1500).unref?.()

// Phase 3 SMOLAB Proposal 9 — Recover orphaned Smolab tasks on startup.
//
// When PM2 restarts the app (or the process crashes), SmolabTaskWorker
// initializes a fresh in-memory queue. DB rows left in status='pending' or
// 'running' from the previous process would otherwise stay orphaned forever
// (the worker never picks them up). recoverPending() scans the DB, bumps the
// `attempts` counter, and re-enqueues them into the new worker's queue so
// they fail-fast through the normal executeTask path (closures are lost
// across restarts — see JSDoc in background-task-worker.ts:recoverPending).
//
// Fire-and-forget: do NOT block Next.js startup on recovery. The worker is a
// singleton (smolabWorker exported from @/lib/smolab/background-task-worker),
// so importing it here just grabs the existing instance.
import('@/lib/smolab/background-task-worker')
  .then(({ smolabWorker }) => smolabWorker.recoverPending())
  .then(({ recovered, markedFailed }) => {
    console.log(
      `[instrumentation] SmolabTaskWorker crash recovery done: ${recovered} re-enqueued, ${markedFailed} marked failed`
    )
  })
  .catch((err) => {
    console.error(
      '[instrumentation] SmolabTaskWorker recoverPending failed:',
      err instanceof Error ? err.message : String(err)
    )
    // Don't block Next.js startup — worker still functions for new tasks
  })

// ============================================================================
// Task 54 — STALE AgentRunRecord CLEANUP (boot)
// ============================================================================
// Goal loop chat-inline chạy IN-PROCESS — server restart/crash giữa chừng để
// lại AgentRunRecord status='running' VĨNH VIỄN trong DB (lệnh update
// completed/failed nằm trong process đã chết — quan sát thật: sub-agent chạy
// `pm2 restart` giữa run của Omega → run "running" mãi mãi trong UI/ops).
// Boot này đánh dấu mọi run 'running' khởi động TRƯỚC process này (dùng lề
// 15s) là crashed. Job-based runs đã có GoalLoopWorker recoverPending riêng —
// cleanup này chỉ đụng AgentRunRecord (bảng hiển thị + metrics).
import('@/lib/db')
  .then(async ({ db }) => {
    const res = await db.agentRunRecord.updateMany({
      where: { status: 'running', startedAt: { lt: new Date(Date.now() - 15_000) } },
      data: { status: 'failed', stopReason: 'crashed', completedAt: new Date() },
    })
    if (res.count > 0) {
      console.log(
        `[instrumentation] Stale AgentRunRecord cleanup: ${res.count} run 'running' mồ côi từ process trước → đánh dấu failed/crashed (server restart giữa chừng)`
      )
    }
  })
  .catch((err) => {
    console.error(
      '[instrumentation] Stale AgentRunRecord cleanup failed:',
      err instanceof Error ? err.message : String(err)
    )
    // Don't block startup — cosmetic cleanup only
  })

// ============================================================================
// GĐ4 CI-5 (Task 14-a) — DURABLE GOAL LOOP WORKER
// ============================================================================
// Job queue nền chạy goal-loop tác vụ nhiều giờ sống sót qua restart (DB là
// queue — checkpoint mỗi vòng + orphan sweep recover). Kiến trúc: POST
// /api/openclaw/chat → enqueue GoalLoopJob (DB) → trả jobId ngay → worker
// tick 5s claim (updateMany conditional) → chạy tối đa 2 job song song →
// checkpoint/heartbeat → completed + finalize seam (14-c). Chi tiết:
// src/lib/goal-loop-worker.ts + contract src/lib/goal-loop-durable-types.ts.
//
// Flag ENABLE_DURABLE_GOAL_LOOP (đọc lúc boot — đổi flag cần restart) giờ chỉ
// điều khiển ROUTE ENQUEUE DURABLE của chat (Task 14-c): flag=false → chat
// chạy inline như cũ, KHÔNG enqueue job. Goal-loop hooks (Task 14-b trong
// agent-goal-loop.ts) luôn sẵn sàng nhưng VÔ HẠI khi không có ai truyền.
//
// REVIEW 13-f: worker giờ start LUÔN (kể cả flag=false) vì Opus auto-mode
// cần 2 chức năng nền của worker: (1) claim directive job do Opus dispatch
// (trước đây dispatchDirectiveGoalLoop tự start on-demand — nhưng reconciliation
// sweep cần worker chạy TRƯỚC directive đầu tiên để bootstrap vòng lặp), và
// (2) OPUS RECONCILIATION SWEEP trong tick (~30s — lưới an toàn tự chữa cho
// auto loop: bắt stall do restart/dispatch chết/verdict rơi rớt). Chi phí khi
// không có auto session + không có job: 1 tick/5s vài query rẻ + sweep/30s
// 1 query — chấp nhận được để auto mode tự vận hành đúng spec user.
// Directive job vẫn KHÔNG đụng đường inline của chat (queue rỗng khi không
// có Opus directive).
//
// globalThis guard chống double-register khi Next dev HMR reload
// instrumentation (pattern như SelfDirection scheduler phía dưới).
const globalForGlw = globalThis as unknown as { __tmoGoalLoopWorkerStarted?: boolean }
if (!globalForGlw.__tmoGoalLoopWorkerStarted) {
  globalForGlw.__tmoGoalLoopWorkerStarted = true
  // REVIEW 13-f: start LUÔN (xem comment khối phía trên) — flag chỉ điều khiển
  // route enqueue durable của chat, không còn điều khiển worker.
  // Đợi DB self-heal xong (ensureDbReady dedup với các lời gọi phía trên)
  // rồi mới sweep + start — tránh requeue/claim đập vào DB chưa migrate.
  // Fire-and-forget: KHÔNG block startup của Next. Nếu DB warm-up lỗi thì
  // vẫn bật worker (tick tự fail-open rồi tự lành — pattern SelfDirection
  // scheduler phía dưới).
  void ensureDbReady()
    .then(() => import('@/lib/goal-loop-worker'))
    .then(async ({ goalLoopWorker }) => {
      const { requeued, markedFailed } = await goalLoopWorker.recoverPending()
      console.log(
        `[instrumentation] GoalLoopWorker boot recovery: ${requeued} job requeue (RESUME từ checkpoint), ${markedFailed} job mark failed (vượt max-attempts)`
      )
      goalLoopWorker.start()
    })
    .catch(async (err) => {
      console.warn(
        '[instrumentation] GoalLoopWorker DB warm-up lỗi — vẫn bật worker (tick tự fail-open rồi tự lành):',
        err instanceof Error ? err.message : String(err)
      )
      try {
        const { goalLoopWorker } = await import('@/lib/goal-loop-worker')
        goalLoopWorker.start()
      } catch (err2) {
        console.error(
          '[instrumentation] GoalLoopWorker start thất bại (worker nền không chạy — app vẫn hoạt động bình thường):',
          err2 instanceof Error ? err2.message : String(err2)
        )
      }
    })
}

// ============================================================================
// SELF-DIRECTION SCHEDULER (fix 2026-08-29 — kiến trúc review)
// ============================================================================
// Trước đây promoteDueProposals()/autoReviewPendingIfDelegated() CHỈ chạy khi
// UI đang mở (GET /api/self-direction/proposals poll 4s gọi side-effects).
// → Đề xuất được duyệt với scheduleAt tương lai KHÔNG tự triển khai "đúng thời
// điểm" nếu user đóng trình duyệt — vi phạm yêu cầu core của module.
//
// Scheduler nền chạy ngay trong process Next.js (được PM2 duy trì):
//   - mỗi 60s: promote đề xuất đến hạn → Omega orchestration
//              + kick Omega auto-review nếu ủy quyền đang bật
//   - stall-detection 10 phút vẫn xử lý orchestration đứt sau restart
// Tất cả fail-open (đã có try/catch bên trong), có globalThis guard chống
// double-register khi Next dev HMR reload instrumentation, và tự đợi DB sẵn
// sàng (ensureDbReady dedup) trước lần chạy đầu.
const globalForSd = globalThis as unknown as { __tmoSdSchedulerStarted?: boolean }
if (!globalForSd.__tmoSdSchedulerStarted) {
  globalForSd.__tmoSdSchedulerStarted = true
  const SD_TICK_MS = 60_000
  let sdTickCount = 0
  const sdTick = async () => {
    const tickNo = ++sdTickCount
    try {
      const { promoteDueProposals, autoReviewPendingIfDelegated } = await import(
        '@/lib/self-direction/orchestrator'
      )
      const triggered = await promoteDueProposals()
      if (triggered.length > 0) {
        console.log(`[SelfDirection][scheduler] Đã kích hoạt triển khai đúng hạn: ${triggered.length} đề xuất`)
      }
      await autoReviewPendingIfDelegated()
      // Heartbeat: tick ĐẦU TIÊN (chứng minh interval sống ngay sau boot) +
      // mỗi 15 tick (15 phút) — heartbeat định kỳ cho ops theo dõi scheduler.
      if (tickNo === 1 || tickNo % 15 === 0) {
        console.log(`[SelfDirection][scheduler] heartbeat tick #${tickNo} — scheduler sống (promoted=${triggered.length})`)
      }
    } catch (err) {
      // Fail-open: tick lỗi thì tick sau sẽ thử lại — không throw phá interval
      console.warn(
        `[SelfDirection][scheduler] tick #${tickNo} lỗi (bỏ qua, chờ tick sau):`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  // Lần đầu: đợi DB self-heal xong rồi mới tick (tránh đập vào DB chưa migrate)
  void ensureDbReady()
    .then(() => new Promise((r) => setTimeout(r, 10_000)))
    .then(() => {
      console.log('[SelfDirection][scheduler] Bật scheduler nền (60s/tick) — đề xuất đến hạn sẽ tự triển khai đúng thời điểm kể cả khi không mở UI')
      void sdTick()
      setInterval(() => void sdTick(), SD_TICK_MS)
    })
    .catch(() => {
      // ensureDbReady hiếm khi reject — nhưng nếu có, vẫn bật scheduler (tick
      // có try/catch riêng + GET proposals side-effects vẫn heal được)
      console.warn('[SelfDirection][scheduler] DB warm-up lỗi — bật scheduler ở chế độ thường trực')
      void sdTick()
      setInterval(() => void sdTick(), SD_TICK_MS)
    })
}

// ============================================================================
// ALISTA SCHEDULER (v1.1 — 2026-09-01) — KỸ SƯ BẢO TRÌ HỆ THỐNG
// ============================================================================
// Ca trực 23h30 hàng ngày (giờ VN), budget 6h (đến 05:30 hôm sau). Pipeline
// kiểm tra toàn diện 7 nhiệm vụ TUẦN TỰ (KHÔNG song song): Tools health,
// Agent runs, Escalations, Domain coverage, 3 tầng dữ liệu, Tự-đánh-giá,
// Database + Memory + Learning (v1.1 mới). Mọi phát hiện → proposal gửi
// Self-Direction.
//
// Scheduler nền chạy ngay trong process Next.js (PM2 duy trì) — không phụ
// thuộc UI mở. Cửa sổ 23:30-23:59 (tz HN), gate 1 lần/ngày. Toàn bộ múi
// giờ qua Intl tz 'Asia/Ho_Chi_Minh' tường minh — không lệch giờ server UTC.
//
// Chống chạy kép: agentId='alista' (≠'default') → automation-engine loop B
// (chỉ xử lý agentId='default') bỏ qua; không set task → mini-service loop A
// (cần task) bỏ qua. Chỉ scheduler nền này làm executor duy nhất.
// CronJob row vẫn hiện trong UI Automation để owner pause/resume + xem
// nextRunAt — điều khiển scheduler nền qua field `enabled`.
//
// globalThis guard chống double-register khi Next dev HMR reload instrumentation
// (pattern như SelfDirection scheduler phía trên).
// FIX v1.1a (bug guard-trùng-tên): KHÔNG set flag ở đây — startAlistaScheduler()
// có globalThis guard riêng (`__alistaSchedulerStarted`). Nếu block này set flag
// cùng tên TRƯỚC khi async chain chạy, startAlistaScheduler sẽ thấy flag đã set
// (do chính block này) → skip → scheduler KHÔNG BAO GIỜ start (đã xảy ra: log chỉ
// thấy "Đã khởi động rồi — skip" ngay lần boot đầu). HMR-safe vẫn đảm bảo vì
// guard của startAlistaScheduler chống double-call.
const globalForAlista = globalThis as unknown as { __alistaSchedulerBlockRan?: boolean }
if (!globalForAlista.__alistaSchedulerBlockRan) {
  globalForAlista.__alistaSchedulerBlockRan = true
  void ensureDbReady()
    .then(() => import('@/lib/alista'))
    .then(({ startAlistaScheduler }) => {
      startAlistaScheduler()
    })
    .catch((err) => {
      console.warn(
        '[ALISTA][scheduler] khởi động fail (không chặn boot — tick sau sẽ tự thử lại):',
        err instanceof Error ? err.message : String(err),
      )
    })
}

// ============================================================================
// CI-6 WORKSPACE BOOTSTRAP (Task 10-b — roadmap CI-6.1)
// ============================================================================
// TMO_DEFAULT_WORKSPACE trỏ thư mục workspace mặc định trên máy user (vd
// E:\APP\TMO-clone — nơi agent Omega thực hiện thay đổi code theo quy trình
// CI-6). Bootstrap MỘT LẦN sau khi DB sẵn sàng (ensureDbReady dedup với các
// lời gọi phía trên): tạo thư mục + git init + remote origin (TMO_REPO_URL)
// + upsert Workspace row active. Hoàn toàn no-op khi env chưa cấu hình
// (sandbox) và fail-open tuyệt đối (lỗi bootstrap không chặn boot).
// globalThis guard chống double-run khi Next dev HMR reload instrumentation.
const globalForWs = globalThis as unknown as { __tmoWorkspaceBootstrapped?: boolean }
if (!globalForWs.__tmoWorkspaceBootstrapped) {
  globalForWs.__tmoWorkspaceBootstrapped = true
  void ensureDbReady()
    .then(() => import('@/lib/workspace/ensure-default-workspace'))
    .then(({ ensureDefaultWorkspace }) => ensureDefaultWorkspace())
    .catch((err) => {
      console.warn(
        '[WORKSPACE] bootstrap lỗi (không chặn boot):',
        err instanceof Error ? err.message : String(err)
      )
    })
}

// ============================================================================
// RESEARCH TEAM SEED (Task 3-fix WORK 2 — audit fix)
// ============================================================================
// Seed 5 research agents (NEMESIS/SIVIL/BELI/LISMA/HAN) sau khi DB sẵn sàng.
// Lười-seed qua GET /api/agents cũng đã đảm bảo nhưng boot seed giúp Agents
// module → Team Research section hiển thị đầy đủ NGAY khi user mở UI (không
// đợi click Agents module). Fire-and-forget — KHÔNG chặn boot. globalThis
// guard chống double-register khi Next dev HMR reload instrumentation.
const globalForResearchSeed = globalThis as unknown as { __tmoResearchTeamSeeded?: boolean }
if (!globalForResearchSeed.__tmoResearchTeamSeeded) {
  globalForResearchSeed.__tmoResearchTeamSeeded = true
  void ensureDbReady()
    .then(() => import('@/lib/research-team/agents'))
    .then(({ ensureResearchTeamAgents }) => ensureResearchTeamAgents())
    .then(() => {
      console.log('[ResearchTeam] seed 5 agents (NEMESIS/SIVIL/BELI/LISMA/HAN) ensured')
    })
    .catch((err) => {
      console.warn(
        '[ResearchTeam] seed lỗi (không chặn boot — GET /api/agents sẽ retry lazy):',
        err instanceof Error ? err.message : String(err),
      )
    })
}

// ============================================================================
// CODE TEAM SEED + AGENT RENAME MIGRATION (2026-10-16)
// ============================================================================
// Boot-seed Code Team 5 agents (giống Research Team phía trên) + chạy rename
// migration APEX→MEGATRON / CORTEX→SHOCWAVE / BOLT→RAMPAGE / RAVAGE→Linh Sickyx
// NGAY khi app khởi động — không đợi user mở module Agents. Fire-and-forget,
// fail-open tuyệt đối (lỗi không chặn boot); GET /api/agents vẫn retry lazy
// như cũ. TASK 48-review: chain thêm boot-seed STANDALONE AGENTS sau CodeTeam
// (rename chạy trước → role-normalize chạy sau — không còn cửa sổ agent nửa
// vời sau restart).
const globalForCodeTeamSeed = globalThis as unknown as { __tmoCodeTeamSeeded?: boolean }
if (!globalForCodeTeamSeed.__tmoCodeTeamSeeded) {
  globalForCodeTeamSeed.__tmoCodeTeamSeeded = true
  void ensureDbReady()
    .then(() => import('@/lib/code-team/agents'))
    .then(({ ensureCodeTeamAgents }) => ensureCodeTeamAgents())
    .then(() => {
      console.log('[CodeTeam] seed 5 agents + rename migration ensured (MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST)')
    })
    .catch((err) => {
      console.warn(
        '[CodeTeam] boot seed/rename lỗi (không chặn boot — GET /api/agents sẽ retry lazy):',
        err instanceof Error ? err.message : String(err),
      )
    })
    // TASK 48-review — BOOT-SEED STANDALONE AGENTS (Linh Sickyx/Omega/ALISTA/Opus).
    // Trước đây chỉ lazy qua GET /api/agents → sau restart, AGENT_RENAMES của
    // CodeTeam boot-seed đã rename RAVAGE → "Linh Sickyx" nhưng role-normalize
    // (team=null, position=null, instruction standalone mới) chưa chạy → cửa
    // sổ thời gian cron/automation/dispatch_agent gọi "Linh Sickyx" nhận agent
    // team='code' + position='SEC' → getAgentPrompt('SEC') = '' (case đã xóa
    // Task 48) → persona rỗng. Chain SAU CodeTeam (không song song) để đúng
    // thứ tự migration tối ưu: rename (CodeTeam) → normalize (Standalone);
    // 2 đường idempotent nên chạy song song vẫn hội tụ, nhưng chain loại bỏ
    // race window. Fire-and-forget + fail-open như mọi boot-seed khác.
    .then(() => import('@/lib/standalone-agents'))
    .then(({ ensureStandaloneAgents }) => ensureStandaloneAgents())
    .then(() => {
      console.log('[Standalone] seed 4 agents ensured (Linh Sickyx/Omega/ALISTA/Opus) — role migration RAVAGE→standalone đã chạy ở boot')
    })
    .catch((err) => {
      console.warn(
        '[Standalone] boot seed/migration lỗi (không chặn boot — GET /api/agents sẽ retry lazy):',
        err instanceof Error ? err.message : String(err),
      )
    })
}

// ============================================================================
// LLM MODEL HEALTH PROBER (Task 20 — 2026-09-03)
// ============================================================================
// Root-cause "Agents không tạo được output do LLM call thất bại": 3 lõi đầu
// chuỗi HANG phía NIM → chuỗi đốt ~450s trước khi tới minimax-m3, trong khi
// caller timeout ngoài (60-180s) giết chuỗi giữa chừng. Prober (llm.ts) probe
// nền 6 lõi mỗi 5 phút: lõi hang → trip breaker NGAY (call thật skip trong ms,
// đi thẳng lõi khỏe); lõi hồi phục → xóa breaker NGAY. Fire-and-forget —
// KHÔNG chặn boot; fail-open; globalThis guard chống double-register HMR.
// FIX Task 20: guard instrumentation dùng flag RIÊNG (__tmoLlmProberBootHookRan)
// — không đụng flag __tmoLlmProberStarted bên trong startModelHealthProber()
// (đụng nhau thì hàm early-return → prober không bao giờ start).
const globalForProber = globalThis as unknown as { __tmoLlmProberBootHookRan?: boolean }
if (!globalForProber.__tmoLlmProberBootHookRan) {
  globalForProber.__tmoLlmProberBootHookRan = true
  void import('@/lib/llm')
    .then(({ startModelHealthProber }) => startModelHealthProber())
    .catch((err) => {
      console.warn(
        '[LLM-Prober] khởi động lỗi (không chặn boot):',
        err instanceof Error ? err.message : String(err),
      )
    })
}

// ============================================================================
// AGENT RENAME INSTRUCTION FIX (Task 20 — 2026-09-03)
// ============================================================================
// Dọn tên cũ (KING/APEX/CORTEX/BOLT) còn sót trong AgentProfile.instruction +
// description của các agent ĐÃ SEED trước các migration rename (migration chỉ
// đổi name/assignment, không dọn persona text → chat NEMESIS bị tự xướng
// "Tôi là KING"). Word-boundary, giữ customization, idempotent (no-op khi
// sạch), chạy mỗi boot — self-heal. Fire-and-forget, fail-open.
const globalForNameFix = globalThis as unknown as { __tmoAgentNameFixRan?: boolean }
if (!globalForNameFix.__tmoAgentNameFixRan) {
  globalForNameFix.__tmoAgentNameFixRan = true
  void ensureDbReady()
    .then(() => import('@/lib/agent-rename-instruction-fix'))
    .then(({ fixStaleAgentNamesInInstructions }) => fixStaleAgentNamesInInstructions())
    .catch((err) => {
      console.warn(
        '[AgentRenameFix] lỗi (không chặn boot):',
        err instanceof Error ? err.message : String(err),
      )
    })
}
