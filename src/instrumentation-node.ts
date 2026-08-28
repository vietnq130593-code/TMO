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

import { startAllServices } from './lib/service-manager'
import { resolve } from 'path'
import { ensureTmoApiToken } from './lib/tmo-token'
import { isOnDemandEnabled, initOnDemandWatchdog } from './lib/openclaw-ondemand'

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

function buildServices(resolveFn: (...paths: string[]) => string) {
  const ROOT = resolveFn(process.cwd())
  const services = [
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
      healthUrl: 'http://127.0.0.1:18789/health',
      healthTimeoutMs: 30000,
      healthIntervalMs: 1000,
      maxRetries: 5,
    },
    {
      name: 'opencode-server',
      cwd: resolve(ROOT, 'mini-services/opencode-server'),
      command: 'bun',
      args: ['index.ts'],
      healthUrl: 'http://127.0.0.1:18790/health',
      healthTimeoutMs: 30000,
      healthIntervalMs: 1000,
      maxRetries: 3,
    },
    {
      name: 'gateway-bridge',
      cwd: resolve(ROOT, 'mini-services/gateway-bridge'),
      command: 'bun',
      args: ['index.ts'],
      healthUrl: 'http://127.0.0.1:18791/health',
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
      },
      healthUrl: 'http://127.0.0.1:3004/health',
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
