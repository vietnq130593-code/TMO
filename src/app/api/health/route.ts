/**
 * Health API — System health check
 *
 * Architecture: SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * Checks connectivity for Qdrant, Neo4j, SQLite, and LLM providers.
 * All health checks run in parallel with individual timeouts.
 */

import { NextResponse } from 'next/server'
import { checkQdrantHealth, initializeCollections } from '@/lib/qdrant'
import { checkNeo4jHealth } from '@/lib/neo4j'
import { checkR2Health } from '@/lib/r2-storage'
import { checkSupabaseHealth } from '@/lib/supabase-sync'
import { db } from '@/lib/db'
import { getNvidiaModels, getProviderDiagnostics, getDailyQuotaStatus } from '@/lib/llm'

export const dynamic = 'force-dynamic'

// Timeout helper: race a promise against a deadline, return fallback on timeout/error
// FIX: the timer is now cleared once settled — previously every call left a pending
// 8-10s setTimeout alive (5 timers per health poll), and the losing promise kept
// running (wasted Qdrant/Aura/Supabase work after the race was decided).
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// LLM health check (lightweight — just checks env var availability, no API calls)
function checkLLMHealthSync(): Record<string, { available: boolean; model: string; error?: string }> {
  const hasNvidiaKeys = !!(process.env.NVIDIA_API_KEY_1 || process.env.NVIDIA_API_KEY_2 || process.env.NVIDIA_API_KEY_3 || process.env.NVIDIA_API_KEY_4)
  const result: Record<string, { available: boolean; model: string; error?: string }> = {}

  result.nvidia = {
    available: hasNvidiaKeys,
    model: getNvidiaModels()[0] || 'openai/gpt-oss-120b',
    error: !hasNvidiaKeys ? 'No NVIDIA API keys configured' : undefined,
  }

  return result
}

// Auto-initialize Qdrant collections on first health check
const globalForInit = globalThis as unknown as { __qdrantInitialized?: boolean }
async function ensureQdrantInitialized() {
  if (!globalForInit.__qdrantInitialized) {
    globalForInit.__qdrantInitialized = true
    try {
      await initializeCollections()
      console.log('[Health] Qdrant collections initialized')
    } catch (err) {
      console.warn('[Health] Qdrant initialization warning:', err instanceof Error ? err.message : String(err))
    }
  }
}

export async function GET() {
  const startTime = Date.now()

  try {
    // Ensure Qdrant collections are created
    // FIX: wrap in withTimeout — the Qdrant client has a 60s timeout, so if Qdrant is
    // unreachable this await could hang the health endpoint for 60s+, which keeps the
    // frontend status bar stuck at "Đang kiểm tra kết nối..." (no per-request timeout there).
    await withTimeout(ensureQdrantInitialized(), 8000, undefined)

    // Run health checks in parallel with individual timeouts
    const [qdrant, neo4j, r2, supabase] = await Promise.all([
      withTimeout(checkQdrantHealth(), 8000, { connected: false, error: 'Qdrant check timed out' }),
      withTimeout(checkNeo4jHealth(), 10000, { connected: false, error: 'Neo4j check timed out (10s)' }),
      withTimeout(checkR2Health(), 8000, { configured: false, connected: false, bucket: '' }),
      withTimeout(checkSupabaseHealth(), 8000, { configured: false, connected: false, tableCount: 0 }),
    ])

    // SQLite health check — try a simple query
    let sqlite: { connected: boolean; error?: string; tableCount?: number }
    try {
      const tableCount = await db.localEntity.count()
      sqlite = { connected: true, tableCount }
    } catch (err) {
      sqlite = { connected: false, error: err instanceof Error ? err.message : 'SQLite check failed' }
    }

    // LLM health is sync (env var check only — no outbound API calls)
    const llm = checkLLMHealthSync()

    // Provider diagnostics — per-key token usage, request counts, key status
    const providerDiagnostics = getProviderDiagnostics()

    // Daily quota status — per-provider daily quota exhaustion info
    const dailyQuotaStatus = getDailyQuotaStatus()

    const responseTimeMs = Date.now() - startTime
    // Neo4j is OPTIONAL — the app works fine without it (chat, agents, skills, memory)
    // Only Qdrant + SQLite + at least 1 LLM provider are required for core functionality
    const coreHealthy = qdrant.connected && sqlite.connected
    const anyLLMAvailable = Object.values(llm).some(v => v.available)

    return NextResponse.json({
      status: coreHealthy && anyLLMAvailable ? 'healthy' : 'degraded',
      responseTimeMs,
      timestamp: new Date().toISOString(),
      services: { qdrant, neo4j, sqlite, r2, supabase, llm },
      providerDiagnostics,
      dailyQuotaStatus,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[Health] Unhandled error:', errorMessage)
    return NextResponse.json({
      status: 'degraded',
      responseTimeMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      services: {
        qdrant: { connected: false, error: 'Health check failed: ' + errorMessage },
        neo4j: { connected: false, error: 'Health check failed: ' + errorMessage },
        sqlite: { connected: false, error: 'Health check failed: ' + errorMessage },
        r2: { configured: false, connected: false, bucket: '' },
        supabase: { configured: false, connected: false, tableCount: 0 },
        llm: {},
      },
    }, { status: 200 })
  }
}
