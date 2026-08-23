/**
 * Service Manager — Auto-start Mini-Services for Theopusflashlite
 *
 * Core engine to spawn, health-check, auto-restart, and gracefully shutdown
 * 3 mini-services: openclaw-gateway, opencode-server, gateway-bridge.
 *
 * Used by: src/instrumentation.ts (Next.js plasmo hook)
 */

import { spawn, ChildProcess } from 'child_process'
import { resolve } from 'path'

// ==================== TYPES ====================

export interface ServiceConfig {
  name: string
  cwd: string
  command: string
  args: string[]
  env?: Record<string, string>
  healthUrl: string
  healthTimeoutMs?: number
  healthIntervalMs?: number
  maxRetries?: number
  dependsOn?: string
}

interface ServiceState {
  process: ChildProcess | null
  status: 'starting' | 'running' | 'stopped' | 'crashed'
  pid: number | null
  startTime: number | null
  restartCount: number
  lastError: string | null
}

// ==================== GLOBAL STATE ====================

const serviceStates = new Map<string, ServiceState>()
const activeProcesses = new Set<ChildProcess>()
let isShuttingDown = false

// ==================== PUBLIC API ====================

/**
 * Start all services in dependency order.
 * Services without `dependsOn` start in parallel.
 * Services with `dependsOn` wait for their dependency to be online.
 */
export async function startAllServices(configs: ServiceConfig[]): Promise<void> {
  // Register graceful shutdown handlers
  // FIX (listener leak on hot reload): previously every call to startAllServices
  // added 2 MORE process listeners (each call = new module evaluation in dev).
  // Guarded via globalThis so exactly one registration survives.
  const globalForSvcMgr = globalThis as unknown as { __svcMgrShutdownRegistered?: boolean }
  if (!globalForSvcMgr.__svcMgrShutdownRegistered) {
    globalForSvcMgr.__svcMgrShutdownRegistered = true
    process.on('SIGTERM', shutdownAll)
    process.on('SIGINT', shutdownAll)
  }

  // Separate independent and dependent services
  const independent = configs.filter(c => !c.dependsOn)
  const dependent = configs.filter(c => c.dependsOn)

  // Start independent services in parallel
  const independentPromises = independent.map(config => startService(config))
  await Promise.allSettled(independentPromises)

  // Start dependent services sequentially (after their dependency is online)
  for (const config of dependent) {
    const depName = config.dependsOn!
    const depState = serviceStates.get(depName)
    if (!depState || depState.status !== 'running') {
      console.warn(`[service-manager] Dependency "${depName}" not running, skipping "${config.name}"`)
      continue
    }
    await startService(config)
  }

  // Log final status
  const running = Array.from(serviceStates.values()).filter(s => s.status === 'running').length
  const total = serviceStates.size
  console.log(`[service-manager] ${running}/${total} services running`)
}

/**
 * Get current status of a service.
 */
export function getServiceStatus(name: string): ServiceState | null {
  return serviceStates.get(name) || null
}

/**
 * Gracefully shutdown all services.
 */
export async function shutdownAll(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('[service-manager] Shutting down all services...')

  const shutdownPromises: Promise<void>[] = []

  for (const [name, state] of serviceStates) {
    if (state.process && !state.process.killed) {
      shutdownPromises.push(
        new Promise<void>((resolve) => {
          const proc = state.process!
          proc.kill('SIGTERM')

          const timeout = setTimeout(() => {
            if (!proc.killed) {
              console.log(`[service-manager] Force killing ${name}...`)
              proc.kill('SIGKILL')
            }
            resolve()
          }, 5000)

          proc.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        })
      )
    }
  }

  await Promise.all(shutdownPromises)
  activeProcesses.clear()
  console.log('[service-manager] All services stopped')
}

// ==================== INTERNALS ====================

async function startService(config: ServiceConfig): Promise<ChildProcess> {
  if (isShuttingDown) {
    throw new Error('Cannot start service while shutting down')
  }

  // Initialize or reset state
  const existing = serviceStates.get(config.name)
  const state: ServiceState = {
    process: null,
    status: 'starting',
    pid: null,
    startTime: Date.now(),
    restartCount: existing?.restartCount || 0,
    lastError: null,
  }
  serviceStates.set(config.name, state)

  console.log(`[service-manager] Starting ${config.name}...`)

  // Spawn the process
  const proc = spawnProcess(config)
  state.process = proc
  state.pid = proc.pid || null
  activeProcesses.add(proc)

  // Wait for health check
  const healthTimeout = config.healthTimeoutMs || 30000
  const blurredInterval = config.healthIntervalMs || 1000
  const isHealthy = await waitForHealth(config.healthUrl, healthTimeout, blurredInterval)

  if (isHealthy) {
    state.status = 'running'
    console.log(`[service-manager] ${config.name} is running (PID: ${state.pid})`)
  } else {
    state.status = 'crashed'
    state.lastError = `Health check failed after ${healthTimeout}ms`
    console.error(`[service-manager] ${config.name} health check failed`)
    // FIX (orphaned child): kill the spawned process on failed health check.
    // Previously it stayed alive holding its port while callers retried — the
    // retry then spawned a second instance that collided on the same port
    // (EADDRINUSE crash loops, as seen with openclaw-gateway).
    try {
      proc.kill()
    } catch { /* already dead */ }
    activeProcesses.delete(proc)
    state.process = null
    state.pid = null
    throw new Error(`Service ${config.name} failed to start`)
  }

  return proc
}

function spawnProcess(config: ServiceConfig): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.env || {}),
  }

  const proc = spawn(config.command, config.args, {
    cwd: config.cwd,
    stdio: ['ignore', 'pipe', 'pipe'] as const,
    env,
    shell: process.platform === 'win32',
  })

  // Pipe stdout with service name prefix
  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n')
    for (const line of lines) {
      if (line.trim()) {
        console.log(`[${config.name}] ${line}`)
      }
    }
  })

  // Pipe stderr with service name prefix
  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n')
    for (const line of lines) {
      if (line.trim()) {
        console.error(`[${config.name}] ${line}`)
      }
    }
  })

  // Handle process exit
  proc.on('exit', (code, signal) => {
    activeProcesses.delete(proc)
    const state = serviceStates.get(config.name)
    if (!state) return

    if (code !== null) {
      console.log(`[service-manager] ${config.name} exited with code ${code}`)
    } else if (signal !== null) {
      console.log(`[service-manager] ${config.name} killed by signal ${signal}`)
    }

    if (!isShuttingDown) {
      handleCrash(config)
    }
  })

  // Handle spawn error
  proc.on('error', (err) => {
    console.error(`[service-manager] ${config.name} spawn error:`, err.message)
    activeProcesses.delete(proc)
    const state = serviceStates.get(config.name)
    if (state) {
      state.lastError = err.message
    }
    if (!isShuttingDown) {
      handleCrash(config)
    }
  })

  return proc
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(intervalMs) })
      if (res.ok) {
        return true
      }
    } catch {
      // Health check failed, retry
    }
    await sleep(intervalMs)
  }

  return false
}

function handleCrash(config: ServiceConfig): void {
  const state = serviceStates.get(config.name)
  if (!state) return

  state.restartCount++
  const maxRetries = config.maxRetries || 5

  if (state.restartCount > maxRetries) {
    console.error(`[service-manager] ${config.name} exceeded max retries (${maxRetries}), giving up`)
    state.status = 'crashed'
    return
  }

  console.log(`[service-manager] ${config.name} crashed, restarting in 3s... (attempt ${state.restartCount}/${maxRetries})`)

  setTimeout(() => {
    if (!isShuttingDown) {
      // MEMORY GUARD: before spawning another service, check system RAM.
      // If usage > 90%, wait until it drops — otherwise we'd re-spawn
      // into the same OOM that just crashed the service, compounding
      // the "spawn storm" that took down the whole app before.
      waitForSystemMemory().then(() => {
        startService(config).catch((err) => {
          console.error(`[service-manager] Failed to restart ${config.name}:`, err.message)
        })
      })
    }
  }, 3000)
}

// ==================== MEMORY GUARD ====================
// Reads /proc/meminfo (Linux only) to get system RAM usage.
// Returns 0 on non-Linux or read failure (assumes OK — better than blocking forever).
function getSystemMemoryUsagePercent(): number {
  try {
    // Avoid importing 'fs' at module top — service-manager runs in Next.js
    // instrumentation which is statically analyzed by the Edge bundler.
    // require() inside a function keeps Node-only code out of the Edge bundle.
    const fs = require('fs')
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8')
    const total = parseInt(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1] || '0', 10) * 1024
    const available = parseInt(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1] || '0', 10) * 1024
    if (total === 0) return 0
    return Math.round(((total - available) / total) * 100)
  } catch {
    return 0
  }
}

const MEMORY_LIMIT_PERCENT = 90
const MEMORY_CHECK_INTERVAL_MS = 10_000

async function waitForSystemMemory(): Promise<void> {
  while (true) {
    const usage = getSystemMemoryUsagePercent()
    if (usage < MEMORY_LIMIT_PERCENT) return
    console.log(`[service-manager] System RAM at ${usage}% (limit ${MEMORY_LIMIT_PERCENT}%), delaying restart...`)
    await sleep(MEMORY_CHECK_INTERVAL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}