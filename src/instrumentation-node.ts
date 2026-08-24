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

function buildServices(resolveFn: (...paths: string[]) => string) {
  const ROOT = resolveFn(process.cwd())
  return [
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
