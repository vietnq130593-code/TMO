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
import { resolve, join } from 'path'
import { readFileSync, readdirSync, statSync, rmSync } from 'fs'
import { ensureTmoApiToken } from './lib/tmo-token'
import { isOnDemandEnabled, initOnDemandWatchdog } from './lib/openclaw-ondemand'
// R5 (2026-10-14 — user request "tự cập nhật mỗi khi thay đổi model miễn
// phí"): đồng bộ danh sách model free opencode/zen (nguồn CLI opencode /
// models.dev, TTL 6h) — boot +90s chạy sớm, tick 30' chỉ sync khi due.
// Mỗi lần chạy ghi observation event 'model.sync' (Đài quan sát).
import { maybeSyncZenFreeModels } from './lib/free-models-sync'
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
// ROUND-46 — SELF-EXIT CÓ DRAIN (cho response đang bay hoàn tất trước khi chết).
// Bằng chứng: 5 lần "Uncaught SyntaxError: Unexpected end of input" trong dev.log
// (vòng 46) — watchdog process.exit() ĐÚNG LÚC server đang stream chunk JS cho
// trình duyệt → response 200 bị CẮT ĐỔI giữa chừng → V8 parse lỗi → trang gãy
// đến khi user tự reload. Cửa sổ drain ngắn (mặc định 600ms, env-tunable
// TMO_SELFEXIT_DRAIN_MS, 0 = tắt = hành vi cũ) cho các chunk đang ghi xong
// (được serve từ memory — mỗi chunk chỉ cần micro-giây để flush) trong khi vẫn
// đứng trong biên an toàn của reaper (HARD tier vẫn dưới ngưỡng reaper SIGINT
// ~2.1-2.2GB). Idempotent: lần gọi thứ 2+ trong cùng drain window là no-op.
// ============================================================================
const SELF_EXIT_DRAIN_MS = Math.max(0, Number(process.env.TMO_SELFEXIT_DRAIN_MS ?? 600))
let selfExitDrainScheduled = false
function selfExitWithDrain(reason: string): void {
  if (selfExitDrainScheduled) return
  selfExitDrainScheduled = true
  if (SELF_EXIT_DRAIN_MS <= 0) {
    process.exit(1)
    return
  }
  console.error(`[SelfExitDrain] ${reason} — chờ ${SELF_EXIT_DRAIN_MS}ms cho response đang bay flush hết rồi exit(1)`)
  const t = setTimeout(() => process.exit(1), SELF_EXIT_DRAIN_MS)
  t.ref?.() // đảm bảo timer chạy dù event loop rảnh
}

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
  // ROUND-11c — HARD-RSS tier: bằng chứng thực chiến có REAPER NGOÀI HỆ THỐNG
  // (sandbox) SIGINT next-server khi RSS ~2.1-2.2GB BẤT KỂ MemAvailable còn dư
  // (14:57:37 kill tại RSS≥1935MB, 15:00:52 kill tại RSS≥2133MB với avail
  // 1102MB; pm2.log KHÔNG có "Stopping app" → không phải PM2; keepalive im;
  // watchdog không log → không phải self-exit của mình; kernel OOM dùng
  // SIGKILL không phải SIGINT). Tự exit TRƯỚC reaper ở ngưỡng thấp hơn → cái
  // chết trở thành CÓ LOG + CÓ KIỂM SOÁT (checkpoint per-iteration giữ nguyên,
  // PM2 restart sạch ~5s, goal jobs RESUME). 0 = tắt tầng này.
  const MEM_WATCHDOG_RSS_HARD_MB = Number(process.env.MEM_WATCHDOG_RSS_HARD_MB ?? 2100)
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
        // HARD-RSS tier — ROUND-11c: reaper sandbox giết ở ~2.1-2.2GB bất kể
        // avail → self-exit sạch TRƯỚC KHI bị SIGINT ngoài ý muốn (xem comment
        // khai báo MEM_WATCHDOG_RSS_HARD_MB). Không cần chờ 2 check — reaper
        // có thể xuống tay bất kỳ lúc nào sau khi RSS vượt vùng này.
        if (MEM_WATCHDOG_RSS_HARD_MB > 0 && rssMb >= MEM_WATCHDOG_RSS_HARD_MB) {
          console.error(`[MemWatchdog] RSS ${rssMb.toFixed(0)}MB ≥ HARD ngưỡng ${MEM_WATCHDOG_RSS_HARD_MB}MB — reaper sandbox thực chiến SIGINT ở ~2.1-2.2GB (vòng 11c) → self-exit sạch TRƯỚC khi bị giết âm thầm (PM2 restart ~5s; durable goal jobs RESUME từ checkpoint)`)
          // ROUND-46 review-fix (2a): return sau khi lên lịch exit — không rơi
          // tiếp xuống các nhánh check khác trong cùng tick (đánh giá round-46:
          // log "RSS cao một mình chưa nguy hiểm" in RA khi exit đã lên lịch —
          // gây nhiễu điều tra vận hành).
          selfExitWithDrain(`MemWatchdog HARD-RSS ${rssMb.toFixed(0)}MB ≥ ${MEM_WATCHDOG_RSS_HARD_MB}MB`)
          return
        }
        // Global-memory guard — ROUND-3 FIX
        if (MEM_WATCHDOG_GLOBAL_MIN_MB > 0 && rssMb > MEM_WATCHDOG_GLOBAL_RSS_MB) {
          const availMb = readMemAvailableMb()
          if (availMb !== null && availMb < MEM_WATCHDOG_GLOBAL_MIN_MB) {
            console.error(`[MemWatchdog] MemAvailable toàn cục ${availMb}MB < ${MEM_WATCHDOG_GLOBAL_MIN_MB}MB (RSS mình ${rssMb.toFixed(0)}MB > ${MEM_WATCHDOG_GLOBAL_RSS_MB}MB) — bộ nhớ HỆ THỐNG cạn, kernel OOM sắp xuống tay — self-exit NGAY để chết có kiểm soát (PM2 restart ~5s; durable goal jobs RESUME từ checkpoint)`)
            selfExitWithDrain(`MemWatchdog global-guard MemAvailable ${availMb}MB < ${MEM_WATCHDOG_GLOBAL_MIN_MB}MB`)
            return
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
          selfExitWithDrain(`MemWatchdog RSS ${rssMb.toFixed(0)}MB vượt ngưỡng 2 check + box chật`)
        }
      } catch { /* fail-open — watchdog lỗi không được phép tự giết app */ }
    }, MEM_WATCHDOG_INTERVAL_MS)
    memWatchdogTimer.unref?.()
    console.log(`[MemWatchdog] bật — ngưỡng RSS ${MEM_WATCHDOG_MB}MB × 2 lần kiểm tra (${Math.round(MEM_WATCHDOG_INTERVAL_MS / 1000)}s/lần, avail-aware: chỉ exit khi MemAvailable<${MEM_WATCHDOG_RSS_EXIT_AVAIL_MB}MB) + global guard MemAvailable<${MEM_WATCHDOG_GLOBAL_MIN_MB}MB khi RSS>${MEM_WATCHDOG_GLOBAL_RSS_MB}MB (exit ngay) + HARD-RSS ${MEM_WATCHDOG_RSS_HARD_MB}MB (exit ngay bất kể avail — chống reaper sandbox SIGINT ~2.1-2.2GB)`)
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
          selfExitWithDrain('HttpWatchdog HTTP intake WEDGE — 3 probe liên tiếp fail')
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

// ==================== OC-CLI ORPHAN SWEEP (fix round-11c) ====================
// Thực chiến 2026-09-30: app spawn `opencode run` (LLM fallback path, llm.ts)
// nhưng khi app chết (SIGINT/watchdog/PM2) child KHÔNG bị giết → mồ côi PPID=1
// mỗi con ~400-520MB RSS. Bắt quả tang 1 con 14h44m/516MB sau 235 lần restart.
// Sweep: quét /proc tìm process `.opencode/bin/opencode` + ` run` có PPID=1
// (cha đã chết — output không bao giờ được đọc) → SIGKILL. An toàn race:
// con của process HIỆN TẠI luôn có PPID=pid mình, không bao giờ bị chạm.
// Chạy lúc boot (+10s) + lặp mỗi 5 phút (bắt leak giữa vòng đời không đợi restart).
function sweepOcCliOrphans(): void {
  try {
    let killed = 0
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const pid = parseInt(entry, 10)
      if (pid === process.pid) continue
      let stat: string
      try { stat = readFileSync(`/proc/${pid}/stat`, 'utf-8') } catch { continue }
      // Field 4 (ppid) — tên process có thể chứa space, cắt sau ') '
      const closeIdx = stat.indexOf(') ')
      if (closeIdx < 0) continue
      const fields = stat.slice(closeIdx + 2).split(' ')
      const ppid = parseInt(fields[1], 10) // fields[0]=state, fields[1]=ppid
      if (ppid !== 1) continue
      let cmdline = ''
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8') } catch { continue }
      if (!cmdline.includes('.opencode/bin/opencode') || !cmdline.includes('run')) continue
      try {
        process.kill(pid, 'SIGKILL')
        killed++
        console.warn(`[OC-CLI-Sweep] SIGKILL opencode run mồ côi PID ${pid} (PPID=1, cha đã chết — leak RAM ~400-520MB)`)
      } catch { /* đã chết */ }
    }
    if (killed > 0) console.warn(`[OC-CLI-Sweep] dọn ${killed} opencode run mồ côi`)
  } catch { /* /proc không có (Windows) — bỏ qua */ }
}
setTimeout(() => sweepOcCliOrphans(), 10_000).unref?.()
setInterval(() => sweepOcCliOrphans(), 5 * 60_000).unref?.()

// ==================== FREE MODELS SYNC (R5 — 2026-10-14) ====================
// Đồng bộ danh sách model free opencode/zen: `opencode models --verbose
// --refresh` (chính chủ — refresh kéo models.dev) → fallback GET models.dev.
// TTL 6h (env FREE_MODELS_SYNC_TTL_MIN); tick 30' kiểm tra (maybeSync tự
// guard TTL — không đốt models.dev mỗi tick); sync lỗi KHÔNG crash app.
// Kết quả overlay lên PROVIDER_MODELS.zen qua /api/agents/models — dropdown
// model tự có model mới, Đài quan sát thấy diff (kind 'model.sync').
setTimeout(() => { void maybeSyncZenFreeModels() }, 90_000).unref?.()
setInterval(() => { void maybeSyncZenFreeModels() }, 30 * 60_000).unref?.()

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
// r70 (BUG2-005 — bằng chứng mission cmuzscdvj…yky79t): 3 sub-run bị restart
// giết được lật thành failed/crashed nhưng metrics TOÀN NULL (tokensUsed/
// toolCalls/cycles) → kế toán ngân sách mission (D5) mù hoàn toàn phần sub
// đã đốt, checkpoint job hiển thị "sub 0" dù sub cháy thật. Giờ: trước khi
// update, đếm toolCalls + iteration cuối TỪ trace jsonl trên đĩa (nguồn
// thật, sống qua crash) — tokensUsed không thể dựng lại trung thực nên giữ
// null (không bịa số).
import('@/lib/db')
  .then(async ({ db }) => {
    const stale = await db.agentRunRecord.findMany({
      where: { status: 'running', startedAt: { lt: new Date(Date.now() - 15_000) } },
      select: {
        id: true, runId: true, agentName: true, createdAt: true, sessionId: true,
        model: true, cycles: true, tokensUsed: true, durationMs: true, toolCalls: true, toolFailures: true,
      },
      take: 50,
    })
    let recoveredMetrics = 0
    let salvaged = 0
    // R4-ĐIỀU TRA (lượt 4) — salvage trọn vẹn từng run mồ côi từ process trước:
    // complete=false + duration + CHAT TRACE (user thấy dấu vết gián đoạn) +
    // verdict resolve/Q-learn — dùng chung salvageCrashedRun với runtime sweep.
    const { salvageCrashedRun } = await import('@/lib/observation/alerts')
    const now = Date.now()
    for (const row of stale) {
      try {
        // r70 BUG2-005 — hồi phục metrics từ trace jsonl trên đĩa (nguồn
        // thật sống qua crash) TRƯỚC khi salvage (salvage giữ tokens trung thực
        // từ checkpoint — không bịa số).
        if (row.runId) {
          try {
            const { existsSync, readFileSync } = await import('fs')
            const tracePath = `agent-runs/${row.runId}.jsonl`
            if (existsSync(tracePath)) {
              const lines = readFileSync(tracePath, 'utf-8').trim().split('\n')
              let toolCalls = 0
              let lastIteration = 0
              for (const ln of lines) {
                try {
                  const j = JSON.parse(ln) as { type?: string; tool?: string; iteration?: number }
                  if (j.type === 'tool' && j.tool) toolCalls++
                  if (typeof j.iteration === 'number' && j.iteration > lastIteration) lastIteration = j.iteration
                } catch { /* dòng hỏng bỏ qua */ }
              }
              if (toolCalls > 0 || lastIteration > 0) {
                await db.agentRunRecord.update({
                  where: { id: row.id },
                  data: {
                    toolCalls,
                    cycles: lastIteration > 0 ? Math.max(1, lastIteration) : null,
                  },
                })
                row.toolCalls = toolCalls
                row.cycles = lastIteration > 0 ? Math.max(1, lastIteration) : row.cycles
                recoveredMetrics++
              }
            }
          } catch { /* fail-open — metrics là phần thưởng */ }
        }
        await salvageCrashedRun(row, now)
        salvaged++
      } catch { /* fail-open từng row */ }
    }
    if (salvaged > 0) {
      console.log(
        `[instrumentation] Stale AgentRunRecord cleanup (R4 salvage): ${salvaged} run 'running' mồ côi từ process trước → failed/crashed + complete=false + duration + chat trace + verdict resolve${recoveredMetrics > 0 ? ` · ${recoveredMetrics} run hồi phục metrics toolCalls/cycles từ trace jsonl (r70 BUG2-005)` : ''}`
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
// P8 (2026-11) — AGENT WORK DATA SWEEP (bộ dọn dữ liệu công việc hết hạn)
// ============================================================================
// Bảng AgentWorkData (tool work_data) là nơi agents ghi dữ liệu công việc CÓ
// VÒNG ĐỜI (thay vì rải rác file rồi bỏ quên — user directive). Bộ dọn này xoá:
//   (a) bản ghi completed/obsolete quá 7 ngày không đụng tới (updatedAt cũ),
//   (b) bản ghi đã quá expiresAt (bất kể status — agent tự đặt hạn khi put).
// Chạy 1 lần lúc boot (sau ensureDbReady — tránh đập vào DB chưa migrate)
// + interval 1 tiếng. Fail-open tuyệt đối: sweep KHÔNG BAO GIỜ làm hỏng boot
// (kể cả khi bảng chưa tồn tại do operator chưa chạy `bun run db:push` sau
// lần thêm model — catch toàn bộ, chỉ log cảnh báo). globalThis guard chống
// double-register khi Next dev HMR reload instrumentation (pattern khối khác).
function sweepAgentWorkData(): void {
  void import('@/lib/db')
    .then(async ({ db }) => {
      const res = await db.agentWorkData.deleteMany({
        where: {
          OR: [
            {
              status: { in: ['completed', 'obsolete'] },
              updatedAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
            },
            { expiresAt: { lt: new Date() } },
          ],
        },
      })
      if (res.count > 0) {
        console.log(`[AgentWorkData] sweep: deleted ${res.count} rows`)
      }
    })
    .catch((err) => {
      // Fail-open — bảng chưa push / DB lỗi → chỉ cảnh báo, không ảnh hưởng app
      console.warn(
        '[AgentWorkData] sweep failed (fail-open — có thể bảng chưa `db:push`):',
        err instanceof Error ? err.message : String(err)
      )
    })
}

const globalForAwds = globalThis as unknown as { __tmoAgentWorkDataSweepStarted?: boolean }
if (!globalForAwds.__tmoAgentWorkDataSweepStarted) {
  globalForAwds.__tmoAgentWorkDataSweepStarted = true
  // Đợi DB self-heal xong rồi sweep lần đầu (ensureDbReady dedup với các lời
  // gọi phía trên); nếu warm-up lỗi thì vẫn không crash — interval bên dưới
  // sẽ tự sweep ở chu kỳ kế.
  void ensureDbReady()
    .then(() => sweepAgentWorkData())
    .catch(() => {
      /* fail-open — không chặn boot */
    })
  const awdsTimer = setInterval(() => sweepAgentWorkData(), 60 * 60 * 1000)
  awdsTimer.unref?.()
}

// ============================================================================
// ROUND-24 review fix — AGENT RUN TRAIL RETENTION (giới hạn đĩa cho P1)
// ============================================================================
// P1 append mọi event ra agent-runs/<runId>.jsonl (bằng chứng bền vững) nhưng
// KHÔNG có cơ chế dọn → đĩa phình vô hạn theo tuần (mỗi mission dài có thể
// hàng MB JSONL). Trail là lớp NHẬN CHỨNG — chỉ cần giữ đủ dài cho đối chiếu
// sau khi run kết thúc; 14 ngày mặc định là dư dả so với chu kỳ mission (giờ
// đến chục tiếng). Env AGENT_RUN_TRAIL_RETENTION_DAYS: 0 = tắt hẳn (giữ mãi).
// Fail-open: lỗi đĩa không ảnh hưởng app; KHÔNG đụng file đang được ghi của
// run đang chạy (chỉ xoá file idle quá hạn theo mtime).
function sweepAgentRunTrails(): void {
  try {
    const retentionDays = Number(process.env.AGENT_RUN_TRAIL_RETENTION_DAYS ?? 14)
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return // 0/invalid = off
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
    // r60 (C6) — tôn trọng TMO_AGENT_RUNS_DIR (đồng bộ agent-run-tracker):
    // khi quality-gate/tests trỏ thư mục ghi sang /tmp, sweep boot của app
    // KHÔNG quét nhầm thư mục đó (và ngược lại không quét sót khi cùng dir).
    // resolve() để env tuyệt đối (/tmp/...) dùng nguyên — không join cwd.
    const dir = (process.env.TMO_AGENT_RUNS_DIR || '').trim() !== ''
      ? resolve((process.env.TMO_AGENT_RUNS_DIR || '').trim())
      : join(process.cwd(), 'agent-runs')
    let deleted = 0
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) {
          rmSync(file)
          deleted++
        }
      } catch { /* file biến mất giữa chừng — bỏ qua */ }
    }
    if (deleted > 0) console.log(`[AgentRunTrails] retention: deleted ${deleted} trail(s) > ${retentionDays} ngày`)
  } catch {
    // fail-open — thư mục chưa tồn tại / lỗi đĩa: im lặng bỏ qua
  }
}

const globalForArtr = globalThis as unknown as { __tmoAgentRunTrailRetentionStarted?: boolean }
if (!globalForArtr.__tmoAgentRunTrailRetentionStarted) {
  globalForArtr.__tmoAgentRunTrailRetentionStarted = true
  sweepAgentRunTrails() // boot — chạy ngay (file IO rẻ, không cần đợi DB)
  const artrTimer = setInterval(() => sweepAgentRunTrails(), 6 * 60 * 60 * 1000) // 6 giờ/lần
  artrTimer.unref?.()
}

// ============================================================================
// ROUND-32 P2-a — TOOL METRIC RETENTION (rollup hằng ngày + dọn raw quá hạn)
// ============================================================================
// ToolMetric ghi 1 row cho MỖI tool execution (choke-point recordAgentActivity
// — mọi tool call của mọi agent). Không TTL → bảng phình vô hạn theo tuần; chính
// ALISTA rule (alista/rules.ts "SQLite DB size > 500MB → archive ToolMetric
// >30 ngày") từng tự nhận ra nợ này nhưng chưa ai triển khai.
//
// Cơ chế (đúng pattern AgentRunTrails retention phía trên):
//   (a) Rollup các ngày HOÀN CHỈNH ĐÃ QUA (date < hôm nay, UTC) sang
//       ToolMetricDaily — 1 row/(ngày, tool, agent): calls/successCount/
//       totalDurationMs/topErrorTags. Idempotent nhờ @@unique + upsert
//       (chạy lại không nhân rollup). Chỉ đụng ngày đã qua để không đua ghi mới.
//   (b) deleteMany raw timestamp < cutoff (SAU khi rollup thành công).
//   (c) Env TOOL_METRIC_RETENTION_DAYS (default 30, 0/invalid = tắt sweep).
// Fail-open tuyệt đối: DB lỗi / bảng chưa db:push → chỉ cảnh báo, không chặn
// boot; interval 6 giờ cũng bỏ qua khi sweep trước còn đang chạy.
const globalForTms = globalThis as unknown as { __tmoToolMetricSweepRunning?: boolean }
function sweepToolMetrics(): void {
  if (globalForTms.__tmoToolMetricSweepRunning) return // sweep trước chưa xong — bỏ chu kỳ
  globalForTms.__tmoToolMetricSweepRunning = true
  void import('@/lib/db')
    .then(async ({ db }) => {
      const retentionDays = Number(process.env.TOOL_METRIC_RETENTION_DAYS ?? 30)
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return // 0/invalid = off
      const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000)

      // Rollup các ngày hoàn chỉnh ĐÃ QUA (date < hôm nay UTC) nằm TRƯỚC cutoff.
      // Raw SQL 1 lượt scan — gọi qua $queryRaw TAGGED TEMPLATE (parameter
      // binding — đúng API; $queryRawUnsafe chỉ nhận string thường: cùng bài học
      // P0-2 đã trả giá ở checkpointWal).
      // LƯU Ý KIỂU DỮ LIỆU (bug bắt được khi verify E2E): Prisma lưu DateTime
      // trong SQLite là INTEGER epoch-ms — KHÔNG dùng strftime('...') trực tiếp
      // trên cột này (luôn NULL). Chuyển sang giây + modifier 'unixepoch'.
      const cutoffDateStr = cutoff.toISOString().slice(0, 10)
      const todayStr = new Date().toISOString().slice(0, 10)
      const cutoffMs = Date.parse(cutoffDateStr + 'T00:00:00.000Z')
      const todayStartMs = Date.parse(todayStr + 'T00:00:00.000Z')
      const rows = await db.$queryRaw<Array<{
        date: string; toolName: string; agentRole: string
        calls: bigint; successCount: bigint; totalDurationMs: bigint
      }>>`
        SELECT date(timestamp / 1000, 'unixepoch') AS date, toolName, agentRole,
               COUNT(*) AS calls,
               SUM(CASE WHEN success THEN 1 ELSE 0 END) AS successCount,
               SUM(durationMs) AS totalDurationMs
        FROM ToolMetric
        WHERE timestamp < ${cutoffMs} AND timestamp < ${todayStartMs}
        GROUP BY date, toolName, agentRole
      `
      if (rows.length === 0) return
      // ROUND-34: rollupWritten chỉ đếm nhóm upsert THÀNH CÔNG + track số
      // nhóm fail — điều kiện xoá raw bên dưới phụ thuộc 2 biến này (bản cũ
      // đếm ++ bất kể .catch nuốt lỗi → log phóng đại + xoá raw sai điều kiện)
      let rollupWritten = 0
      let rollupFailed = 0
      for (const r of rows) {
        // Top error tags cho nhóm này (top 10) — chỉ tính row thất bại
        // (date(...) + 'unixepoch' — cột là INTEGER epoch-ms, xem chú thích trên)
        const errRows = await db.$queryRaw<Array<{ errorTag: string; n: bigint }>>`
          SELECT errorTag, COUNT(*) AS n FROM ToolMetric
          WHERE date(timestamp / 1000, 'unixepoch') = ${r.date}
            AND toolName = ${r.toolName} AND agentRole = ${r.agentRole}
            AND errorTag IS NOT NULL
          GROUP BY errorTag ORDER BY n DESC LIMIT 10
        `
        const topTags: Record<string, number> = {}
        for (const e of errRows) topTags[String(e.errorTag)] = Number(e.n)

        await db.toolMetricDaily.upsert({
          where: { date_toolName_agentRole: { date: r.date, toolName: r.toolName, agentRole: r.agentRole } },
          create: {
            date: r.date, toolName: r.toolName, agentRole: r.agentRole,
            calls: Number(r.calls), successCount: Number(r.successCount),
            totalDurationMs: BigInt(r.totalDurationMs ?? 0),
            topErrorTags: JSON.stringify(topTags),
          },
          update: {
            calls: Number(r.calls), successCount: Number(r.successCount),
            totalDurationMs: BigInt(r.totalDurationMs ?? 0),
            topErrorTags: JSON.stringify(topTags),
            computedAt: new Date(),
          },
        }).then(() => { rollupWritten++ }).catch(() => {
          // từng nhóm fail-open — sweep tổng tiếp tục, NHƯNG không được xoá
          // raw của nhóm chưa rollup (xem điều kiện xoá bên dưới)
          rollupFailed++
        })
      }

      // (b) Xoá raw đã rollup (những ngày < cutoffDateStr) — CHỈ sau khi rollup
      // lượt này thành công cho MỌI nhóm (fail 1 nhóm thì giữ nguyên raw toàn bộ
      // để lượt sweep sau làm lại — an toàn hơn là mất dữ liệu).
      // ROUND-34: bản cũ gọi deleteMany VÔ ĐIỀU KIỆN ngay sau vòng for dù comment
      // hứa điều kiện trên — nếu upsert fail cho vài nhóm (DB locked tích tắc...)
      // thì raw của chính những nhóm đó bị xoá trong khi rollup chưa ghi → MẤT
      // DỮ LIỆU vĩnh viễn. Giờ chỉ xoá khi rollupFailed === 0; có fail → giữ
      // toàn bộ raw (upsert idempotent nhờ @@unique nên lượt sweep sau 6h làm
      // lại an toàn, không nhân đôi số).
      if (rollupFailed > 0) {
        console.warn(
          `[ToolMetrics] retention: ${rollupFailed}/${rows.length} nhóm rollup FAIL — GIỮ NGUYÊN raw (không xoá) để lượt sweep sau làm lại (round-34 chống mất dữ liệu)`
        )
        return
      }
      const deleted = await db.toolMetric.deleteMany({
        where: { timestamp: { lt: new Date(cutoffDateStr + 'T00:00:00.000Z') } },
      })
      if (rollupWritten > 0 || deleted.count > 0) {
        console.log(
          `[ToolMetrics] retention: rollup ${rollupWritten} nhóm (ngày < ${cutoffDateStr}), xóa ${deleted.count} raw rows > ${retentionDays} ngày`
        )
      }
    })
    .catch((err) => {
      // Fail-open — bảng chưa push / DB lỗi → chỉ cảnh báo
      console.warn(
        '[ToolMetrics] sweep failed (fail-open — có thể bảng chưa `db:push`):',
        err instanceof Error ? err.message : String(err)
      )
    })
    .finally(() => {
      globalForTms.__tmoToolMetricSweepRunning = false
    })
}

const globalForTmr = globalThis as unknown as { __tmoToolMetricRetentionStarted?: boolean }
if (!globalForTmr.__tmoToolMetricRetentionStarted) {
  globalForTmr.__tmoToolMetricRetentionStarted = true
  // Đợi DB self-heal xong rồi sweep lần đầu (bảng có thể chưa tồn tại — catch
  // bên trong đã fail-open); interval 6h như AgentRunTrails retention.
  void ensureDbReady()
    .then(() => sweepToolMetrics())
    .catch(() => { /* fail-open — không chặn boot */ })
  const tmrTimer = setInterval(() => sweepToolMetrics(), 6 * 60 * 60 * 1000)
  tmrTimer.unref?.()
}

// ==================== ROUND-35 (C-3): NEO4J INDEX TỰ CHỮA MỖI BOOT ====================
// Blueprint P1-b/P2-c thiết kế fulltext labels + vector-index dim "tự phát hiện
// lệch chuẩn → tự DROP+CREATE lại MỖI BOOT", nhưng round-33 chỉ wire qua POST
// /api/setup/neo4j (manual) — round-34 trả lời user "Neo4j fulltext + Qdrant dim
// guard tự chữa mỗi boot" trong khi phần Neo4j chưa hề chạy ở boot. Giờ chạy
// nền sau ensureDbReady: idempotent (khớp chuẩn = no-op — 2 SHOW INDEXES rẻ),
// fail-open tuyệt đối (Aura lỗi/quên env → chỉ cảnh báo, không chặn boot).
const globalForNmi = globalThis as unknown as { __tmoNeo4jIndexMigrateStarted?: boolean }
if (!globalForNmi.__tmoNeo4jIndexMigrateStarted) {
  globalForNmi.__tmoNeo4jIndexMigrateStarted = true
  void (async () => {
    try {
      const { migrateNeo4jIndexes } = await import('./lib/neo4j')
      await ensureDbReady()
      await migrateNeo4jIndexes()
    } catch (err) {
      console.warn(
        '[Neo4j] Boot index migration (C-3) failed (non-fatal):',
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
}

// ==================== ROUND-36: EPISODIC + DRIFT HEAL MỖI BOOT ====================
// Rà soát lượt 3 phát hiện "bộ não mất trí nhớ sau reset": Qdrant bị xoá
// collection (theopus_episodes) + SQLite deploy lại trắng, nhưng Neo4j Aura
// còn nguyên 94 Episode / 64 Lesson → searchSimilarEpisodes luôn [], SQLite
// mirror trống, embedding_id treo — KHÔNG có đường backfill. Giờ boot check
// desync (4 count query rẻ) và heal nền 3 tầng (re-embed từ Neo4j
// contextSummary + update embedding_id + backfill mirror). Idempotent, fail
// mở tuyệt đối. Env TMO_EPISODIC_HEAL=0 tắt.
// Cùng block: heal model-version tracking (B-Y-4) — seed EmbeddingModelVersion
// + stamp chunk payload embedding_model_version còn thiếu để drift detection
// (Prop 4.1) thật sự chạy (0 embed API call — rẻ).
const globalForEh = globalThis as unknown as { __tmoBootHealStarted?: boolean }
if (!globalForEh.__tmoBootHealStarted) {
  globalForEh.__tmoBootHealStarted = true
  void (async () => {
    try {
      await ensureDbReady()
      // Episodic heal có thể re-embed hàng chục episode (API call + vài phút)
      // — chạy nền, không chặn boot; desync check bên trong sẽ skip khi đã khớp.
      const { maybeHealEpisodicStores } = await import('./lib/episodic-memory/backfill')
      void maybeHealEpisodicStores().then((r) => {
        if (!r.healed) {
          console.log(`[Boot Heal] Episodic stores: skip — ${r.reason}`)
        }
      })
    } catch (err) {
      console.warn(
        '[Boot Heal] Episodic heal failed (non-fatal):',
        err instanceof Error ? err.message : String(err)
      )
    }
    try {
      await ensureDbReady()
      const { maybeHealModelVersionTracking } = await import('./lib/kb-routing/drift-heal')
      await maybeHealModelVersionTracking()
    } catch (err) {
      console.warn(
        '[Boot Heal] Model-version tracking failed (non-fatal):',
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
}

// ============================================================================
// ROUND-32 P3-c — DAILY SQLITE BACKUP (tự động, best-effort)
// ============================================================================
// Route /api/storage/db-backup sinh ra đúng cho việc này (header route ghi rõ
// "Periodic safety: cron POST once a day") nhưng chưa có bộ lên lịch nào —
// backup chỉ xảy ra khi có người chủ động gọi. Bộ lập lịch này tự POST endpoint
// backup qua SELF-FETCH trực tiếp localhost (server tự gọi server — không qua
// gateway/caddy, không phụ thuộc mini-service):
//   - Boot + 5 phút (đợi app lên hẳn): kiểm tra bản cuối trên R2 (lastModified
//     của latest pointer) — chỉ backup nếu đã > 20h (đệm 4h cho restart drift;
//     backup mỗi lần restart sẽ spam R2 history).
//   - Interval 1 giờ lặp lại phép đối chiếu đó → hiệu quả: 1 backup/ngày.
//   - Best-effort toàn bộ: R2 hỏng/lỗi fetch → chỉ log cảnh báo, chu kỳ sau thử lại.
//   - Env TMO_AUTO_BACKUP=0 để tắt hẳn (vd khi muốn chủ động điều phối tay).
const globalForDsb = globalThis as unknown as { __tmoDailySqliteBackupStarted?: boolean }
function maybeDailyBackup(): void {
  if (process.env.TMO_AUTO_BACKUP === '0') return
  void (async () => {
    try {
      const base = `http://localhost:${process.env.PORT || 3000}`
      // Đối chiếu bản cuối trên R2 — tránh backup chồng khi app restart thường xuyên
      const listRes = await fetch(`${base}/api/storage/db-backup`, {
        signal: AbortSignal.timeout(20_000),
      })
      if (!listRes.ok) throw new Error(`list endpoint ${listRes.status}`)
      const list = (await listRes.json().catch(() => ({}))) as {
        backups?: Array<{ isLatest: boolean; lastModified: string }>
      }
      const latest = list.backups?.find(b => b.isLatest)
      const lastAt = latest ? Date.parse(latest.lastModified) : 0
      const MIN_INTERVAL_MS = 20 * 3600 * 1000
      if (Number.isFinite(lastAt) && Date.now() - lastAt < MIN_INTERVAL_MS) {
        return // đã có bản tươi trong 20h — không cần backup mới
      }
      const postRes = await fetch(`${base}/api/storage/db-backup`, {
        method: 'POST',
        signal: AbortSignal.timeout(180_000),
      })
      const body = (await postRes.json().catch(() => ({}))) as {
        versionedKey?: string
        verify?: { sha256Match?: boolean; sqliteHeaderOk?: boolean }
        error?: string
      }
      if (!postRes.ok) throw new Error(`backup endpoint ${postRes.status}: ${body.error ?? ''}`)
      const verifyOk = body.verify?.sha256Match && body.verify?.sqliteHeaderOk
      console.log(
        `[AutoBackup] DB snapshot hằng ngày: ${body.versionedKey ?? '(không có key)'}${verifyOk ? ' (verify PASS)' : ' (⚠️ VERIFY KHÔNG PASS — xem log route)'}` 
      )
    } catch (err) {
      console.warn(
        '[AutoBackup] daily backup failed (best-effort — thử lại chu kỳ sau):',
        err instanceof Error ? err.message : String(err)
      )
    }
  })()
}
if (!globalForDsb.__tmoDailySqliteBackupStarted) {
  globalForDsb.__tmoDailySqliteBackupStarted = true
  // Đợi 5 phút sau boot cho app lên hẳn (route compile xong, schedulers khác ổn định)
  const dsbBootTimer = setTimeout(() => maybeDailyBackup(), 5 * 60 * 1000)
  dsbBootTimer.unref?.()
  const dsbTimer = setInterval(() => maybeDailyBackup(), 60 * 60 * 1000) // đối chiếu mỗi giờ
  dsbTimer.unref?.()
}

// ============================================================================
// ROUND-37 V2b — PATTERN ESCALATION → SELF-DIRECTION (Q4 "tự cải tiến" nối)
// ============================================================================
// Rà soát lượt 3: getEscalationCandidates (C.2 — root_cause lặp ≥3 lần → đề
// xuất cải tiến hệ thống) chỉ được ĐỌC bởi /api/episodic/overview (hiển thị)
// + ALISTA ca đêm (LLM, chẩn đoán). KHÔNG có đường deterministic nào nối
// "lỗi hệ thống lặp" → "đề xuất cải tiến" — vòng tự cải tiến hở giữa chừng.
// Sweep này chạy boot (+3 phút) + mỗi 6h:
//   getEscalationCandidates(3) → mỗi candidate (occurrences≥3, unresolved≥2)
//   → tạo SelfDirectionProposal (category=improvement) với 4 phần chuẩn, dẫn
//   chứng số liệu thật từ Neo4j. Dedupe: proposal cùng rootCause còn sống
//   trong 7 ngày → skip. Fail-open tuyệt đối; env TMO_ESCALATION_SWEEP=0 tắt.
const globalForEsc = globalThis as unknown as {
  __tmoEscalationSweepStarted?: boolean
  /** ROUND-38 fix F7d — re-entrancy guard: sweep đang chạy thì timer kế
   * (6h) KHÔNG chồng chu kỳ — tránh duplicate proposals khi sweep dài. */
  __tmoEscalationSweepRunning?: boolean
}
function sweepEscalationImprovements(): void {
  if (process.env.TMO_ESCALATION_SWEEP === '0') return
  if (globalForEsc.__tmoEscalationSweepRunning) return
  globalForEsc.__tmoEscalationSweepRunning = true
  void (async () => {
    try {
      await ensureDbReady()
      const { getEscalationCandidates } = await import('./lib/episodic-memory/episodic-neo4j')
      // ROUND-38 fix F7a: lọc bỏ candidate thiếu rootCause TRƯỚC — trước đây
      // `cand.rootCause.toLowerCase()` ở vòng lặp dưới throw trên null → CẢ
      // sweep abort (bắt bởi catch ngoài nhưng mất nguyên chu kỳ).
      const candidates = (await getEscalationCandidates(3)).filter(c => typeof c.rootCause === 'string' && c.rootCause.trim().length > 0)
      const qualifying = candidates.filter(c => c.occurrences >= 3 && (c.occurrences - c.resolved) >= 2)
      if (qualifying.length === 0) return

      const { db } = await import('./lib/db')
      const { createSelfDirectionProposal } = await import('./lib/self-direction/orchestrator')

      // Dedupe: proposal escalation cùng rootCause đã tồn tại (còn pending
      // HOẶC bị xử lý trong 7 ngày gần đây — tránh re-escalate noise sau reject)
      // ROUND-38 fix F7b: bỏ regex parse title (gãy khi rootCause chứa dấu
      // nháy/đổi format) — match bằng includes-thường-hoá.
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000)
      const existing = await db.selfDirectionProposal.findMany({
        where: {
          createdBy: 'episodic-escalation-sweep',
          OR: [{ status: 'pending' }, { createdAt: { gte: weekAgo } }],
        },
        select: { title: true },
      })
      const existingTitles = existing.map(p => p.title.toLowerCase())

      let created = 0
      for (const cand of qualifying) {
        const rootCauseKey = cand.rootCause.toLowerCase()
        if (existingTitles.some(t => t.includes(rootCauseKey))) continue
        // Cap 3 proposal/chu kỳ — ưu tiên nghiêm trọng nhất (candidates đã sort)
        if (created >= 3) break

        const unresolved = cand.occurrences - cand.resolved
        const recentErrors = cand.recentErrors.slice(0, 3).map((e, i) => `  ${i + 1}. ${String(e).slice(0, 160)}`).join('\n')
        // ROUND-38 fix F7c: thoát nháy đơn trong text Cypher hướng dẫn (văn
        // bản proposal — không execute) để người đọc copy-paste không gãy query
        const cypherSafeRootCause = cand.rootCause.replace(/'/g, "\\'")
        await createSelfDirectionProposal({
          title: `[Escalation] Root cause "${cand.rootCause.replace(/"/g, "'")}" lặp ${cand.occurrences} lần`,
          category: 'improvement',
          priority: unresolved >= 10 ? 'high' : 'medium',
          problem: `Neo4j ErrorOccurrence ghi nhận root cause "${cand.rootCause}" lặp ${cand.occurrences} lần (chưa resolve ${unresolved}) — dấu hiệu lỗi hệ thống mang tính khuôn mẫu, không phải sự cố đơn lẻ. Các thông báo gần nhất:\n${recentErrors || '  (không có sample)'}`,
          solution: 'Phân tích các lần xuất hiện lỗi cùng root cause → tìm nguyên nhân chung (config, dependency, flow) → khắc phục tận gốc thay vì xử lý từng lần một.',
          implementation: `1) Query Neo4j MATCH (e:ErrorOccurrence {root_cause: '${cypherSafeRootCause}'}) RETURN e.raw_message, e.occurred_at ORDER BY occurred_at DESC LIMIT 20; 2) Gom nhóm theo manifestation/tool; 3) Đề xuất fix tận gốc (code/config) kèm tiêu chí xác nhận: occurrences mới của root cause này = 0 sau 7 ngày.`,
          scheduleAt: unresolved >= 10 ? new Date(Date.now() + 12 * 3600_000) : null,
          impact: `Chặn ${(unresolved / Math.max(1, cand.occurrences) * 100).toFixed(0)}% lỗi còn tồn đọng của pattern này tái diễn.`,
          status: 'pending',
          source: 'scan',
          createdBy: 'episodic-escalation-sweep',
        })
        // OBS-V3 H5 (BLUEPRINT-OBSERVATION-V3 §C.1 — R34): pattern lỗi lặp ≥3
        // lần đã leo lên thành SelfDirectionProposal — vào timeline quan sát
        // (trước giờ chỉ thấy qua UI duyệt đề xuất). Fail-open tuyệt đối.
        try {
          const { observeEvent } = await import('./lib/observation/ledger')
          observeEvent({
            actor: 'system:episodic',
            kind: 'learn.escalate',
            table: 'SelfDirectionProposal',
            summary:
              `Escalate bài học — root cause "${cand.rootCause.slice(0, 120)}" lặp ${cand.occurrences} lần` +
              ` (chưa resolve ${unresolved}) → đề xuất cải tiến ${unresolved >= 10 ? 'ưu tiên cao' : 'ưu tiên trung'}`,
            payload: {
              rootCause: cand.rootCause.slice(0, 200),
              occurrences: cand.occurrences,
              resolved: cand.resolved,
              unresolved,
              priority: unresolved >= 10 ? 'high' : 'medium',
              recentErrors: cand.recentErrors.slice(0, 3),
            },
          })
        } catch { /* fail-open — quan sát không được làm hỏng sweep */ }
        existingTitles.push(`[escalation] root cause "${cand.rootCause.replace(/"/g, "'")}" lặp ${cand.occurrences} lần`.toLowerCase())
        created++
      }
      if (created > 0) {
        console.log(`[EscalationSweep] V2b — tạo ${created} SelfDirectionProposal cải tiến từ ${qualifying.length} pattern escalation (Q4 tự cải tiến nối)`)
      }
    } catch (err) {
      console.warn('[EscalationSweep] sweep failed (fail-open — thử lại chu kỳ sau):', err instanceof Error ? err.message : String(err))
    } finally {
      // ROUND-38 fix F7d: nhả re-entrancy guard — interval 6h không chồng
      // chu kỳ (sweep dài + timer chạy lại → duplicate proposals)
      globalForEsc.__tmoEscalationSweepRunning = false
    }
  })()
}
if (!globalForEsc.__tmoEscalationSweepStarted) {
  globalForEsc.__tmoEscalationSweepStarted = true
  const escBootTimer = setTimeout(() => sweepEscalationImprovements(), 3 * 60 * 1000)
  escBootTimer.unref?.()
  const escTimer = setInterval(() => sweepEscalationImprovements(), 6 * 60 * 60 * 1000)
  escTimer.unref?.()
}

// ============================================================================
// ROUND-37 V2c — EPISODIC DECAY CRON (Q4 decay không còn manual-only)
// ============================================================================
// Rà soát lượt 3: decayEpisodes (A.4 Q4 — "quên có kiểm soát": episode không
// được dùng 30 ngày → importance ×0.9) CHỈ chạy khi ai đó POST thủ công vào
// /api/episodic/decay. Bộ não không bao giờ tự quên → importance cũ chồng
// chất, retrieval ngày càng nhiễu bởi các episode thừa. Sweep này chạy boot
// (+10 phút) + mỗi 24h: decayEpisodes({days:30, factor:0.9}) — idempotent
// nhờ marker last_decayed (mỗi chu kỳ 30 ngày chỉ decay 1 lần, đã fix
// compounding decay round-34). Env TMO_EPISODIC_DECAY=0 tắt.
const globalForEdec = globalThis as unknown as { __tmoEpisodicDecayStarted?: boolean }
function sweepEpisodicDecay(): void {
  if (process.env.TMO_EPISODIC_DECAY === '0') return
  void (async () => {
    try {
      const { decayEpisodes } = await import('./lib/episodic-memory/episodic-neo4j')
      const decayed = await decayEpisodes({ days: 30, factor: 0.9 })
      if (decayed > 0) {
        console.log(`[EpisodicDecay] V2c — tự động decay ${decayed} episode không được dùng ≥30 ngày (×0.9, idempotent theo last_decayed)`)
      }
    } catch (err) {
      console.warn('[EpisodicDecay] decay sweep failed (fail-open):', err instanceof Error ? err.message : String(err))
    }
  })()
}
if (!globalForEdec.__tmoEpisodicDecayStarted) {
  globalForEdec.__tmoEpisodicDecayStarted = true
  const edecBootTimer = setTimeout(() => sweepEpisodicDecay(), 10 * 60 * 1000)
  edecBootTimer.unref?.()
  const edecTimer = setInterval(() => sweepEpisodicDecay(), 24 * 60 * 60 * 1000)
  edecTimer.unref?.()
}

// ============================================================================
// ROUND-38 fix F4 — STALE PENDING ADAPTATION LOG SWEEPER
// ============================================================================
// Rà soát lần 1 round-37: markSessionAdaptationOutcome chỉ đóng được log khi
// step từng fail CHẠY LẠI trong cùng process còn session state sống (TTL 2h).
// Step không bao giờ chạy lại (pipeline xong/ESCALATE/cancel/restart) →
// StrategyAdaptationLog.successful MÃI MÃI null — thống kê adaptation không
// bao giờ chốt. Sweeper: pending > 48h không outcome → successful=false
// (không có bằng chứng adaptation hiệu quả = không thành công — trung thực).
// Cùng mốc 24h với decay sweep (tách +15 phút cho lệch tải).
const globalForStale = globalThis as unknown as { __tmoStaleAdaptationSweepStarted?: boolean }
function sweepStaleAdaptationLogs(): void {
  if (process.env.TMO_STALE_ADAPTATION_SWEEP === '0') return
  void (async () => {
    try {
      await ensureDbReady()
      const { db } = await import('./lib/db')
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)
      const result = await db.strategyAdaptationLog.updateMany({
        where: { successful: null, createdAt: { lt: cutoff } },
        data: { successful: false },
      })
      if (result.count > 0) {
        console.log(`[StaleAdaptationSweep] F4 — đóng ${result.count} StrategyAdaptationLog pending >48h không outcome (successful=false — không bằng chứng là adaptation hiệu quả)`)
      }
    } catch (err) {
      console.warn('[StaleAdaptationSweep] sweep failed (fail-open):', err instanceof Error ? err.message : String(err))
    }
  })()
}
if (!globalForStale.__tmoStaleAdaptationSweepStarted) {
  globalForStale.__tmoStaleAdaptationSweepStarted = true
  const staleBootTimer = setTimeout(() => sweepStaleAdaptationLogs(), 25 * 60 * 1000)
  staleBootTimer.unref?.()
  const staleTimer = setInterval(() => sweepStaleAdaptationLogs(), 24 * 60 * 60 * 1000)
  staleTimer.unref?.()
}

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
// OBS-P4 (BLUEPRINT-OBSERVATION §C.6 — Task 23 2026-10-13): OBSERVATION
// IMPACT WORKER — job nền 10 phút chấm impact.estimate (KPI window quanh
// mỗi TuningChangeLog) + obs.health (meta-health ledger). Cờ obs_impact off
// mặc định → tick rỗng (rẻ); check cờ MỖI tick nên bật là hiệu lực ngay.
// globalThis guard chống double-register HMR (pattern GoalLoopWorker trên).
// ============================================================================
const globalForObsImpactBoot = globalThis as unknown as { __tmoObsImpactBooted?: boolean }
if (!globalForObsImpactBoot.__tmoObsImpactBooted) {
  globalForObsImpactBoot.__tmoObsImpactBooted = true
  void import('@/lib/observation/impact')
    .then(({ startObservationImpactWorker }) => {
      startObservationImpactWorker()
    })
    .catch(err => {
      console.warn(
        '[instrumentation] ObservationImpactWorker start thất bại (quan sát tác động không chạy — app vẫn hoạt động bình thường):',
        err instanceof Error ? err.message : String(err),
      )
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
// Root-cause (lịch sử 2026-09-03, giữ làm ghi chú): chuỗi fallback NIM cũ
// HANG ~450s trước khi tới lõi cuối, trong khi
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
