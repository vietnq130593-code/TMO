/**
 * Health API — System health check
 *
 * Architecture: SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * Checks connectivity for Qdrant, Neo4j, SQLite, and LLM providers.
 * All health checks run in parallel with individual timeouts.
 */

import { NextResponse, NextRequest } from 'next/server'
import { checkQdrantHealth, initializeCollections } from '@/lib/qdrant'
import { checkNeo4jHealth } from '@/lib/neo4j'
import { checkR2Health } from '@/lib/r2-storage'
import { checkSupabaseHealth } from '@/lib/supabase-sync'
import { db } from '@/lib/db'
import { getNvidiaModels, getProviderDiagnostics, getDailyQuotaStatus, getModelBlockBreakers, isZaiRoutingEnabled, getZai429Status, getZenStatus } from '@/lib/llm'

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
function checkLLMHealthSync(): Record<string, { available: boolean; model: string; error?: string; active?: boolean; note?: string }> {
  const hasNvidiaKeys = !!(process.env.NVIDIA_API_KEY_1 || process.env.NVIDIA_API_KEY_2 || process.env.NVIDIA_API_KEY_3 || process.env.NVIDIA_API_KEY_4)
  const result: Record<string, { available: boolean; model: string; error?: string; active?: boolean; note?: string }> = {}

  // ━━ Z-AI SDK provider (dựng lại 2026-09-06 — LLM_PROVIDER=zai) ━━
  // Khi bật: TOÀN BỘ lõi (agent + chat + utility + extraction) route qua
  // z-ai-web-dev-sdk (GLM gateway). NIM giữ làm fallback (sdk init fail →
  // tự fall về chuỗi NIM). Circuit 429 ZAI cũng được expose để theo dõi.
  const zaiActive = isZaiRoutingEnabled()
  result['zai-sdk'] = {
    available: zaiActive,
    model: 'glm-4-plus (gateway chọn)',
    active: zaiActive,
    error: zaiActive ? undefined : 'LLM_PROVIDER != zai — không bật (NIM-only)',
    note: zaiActive
      ? `ĐANG ĐIỀU HÀNH toàn bộ lõi (agent+chat+utility+extraction) · 429-circuit: ${getZai429Status().active ? `MỞ (còn ${Math.ceil(getZai429Status().remainingMs / 1000)}s, trips=${getZai429Status().trips})` : 'đóng (không rate-limit)'}`
      : undefined,
  }

  result.nvidia = {
    available: hasNvidiaKeys,
    model: getNvidiaModels()[0] || 'minimaxai/minimax-m3',
    active: !zaiActive,
    error: !hasNvidiaKeys ? 'No NVIDIA API keys configured' : undefined,
    note: zaiActive && hasNvidiaKeys ? 'fallback (sdk init fail → NIM chain)' : undefined,
  }

  // ━━ OpenCode Zen provider (2026-09-24 — user directive) ━━
  // Free coding models (nemotron-3-ultra-free + muse-spark-1.3-contributor-free).
  // Agents configured provider='zen' route here BEFORE model-first policy.
  // 2-key rotation pool; Zen fail → NIM kimi-k3 fallback chain.
  const zenStatus = getZenStatus()
  result.zen = {
    available: zenStatus.configured,
    model: zenStatus.models.join(' + '),
    active: zenStatus.configured,
    error: !zenStatus.configured ? 'No ZEN_API_KEY configured' : undefined,
    note: zenStatus.configured
      ? `${zenStatus.keyCount} key(s) · ${zenStatus.availableKeys} available · ${zenStatus.rateLimitedKeys} rate-limited · nemotron-3-ultra-free (TL/Omega/Opus) + muse-spark-1.3-contributor-free (G1-G3/ALISTA)`
      : undefined,
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

export async function GET(request: NextRequest) {
  const startTime = Date.now()

  // FIX #8 (display bug): allow callers to bypass the Neo4j health cache by
  // passing ?force=true. The frontend calls /api/health?force=true right
  // after a "Tiếp tục" pipeline finishes, so the dashboard's Neo4j info panel
  // immediately reflects the freshly-written nodes/relationships instead of
  // being stuck on the 20s cached value from before the pipeline ran.
  const forceRefresh = request.nextUrl.searchParams.get('force') === 'true'

  try {
    // Ensure Qdrant collections are created
    // FIX: wrap in withTimeout — the Qdrant client has a 60s timeout, so if Qdrant is
    // unreachable this await could hang the health endpoint for 60s+, which keeps the
    // frontend status bar stuck at "Đang kiểm tra kết nối..." (no per-request timeout there).
    await withTimeout(ensureQdrantInitialized(), 8000, undefined)

    // Run health checks in parallel with individual timeouts
    const [qdrant, neo4j, r2, supabase] = await Promise.all([
      withTimeout(checkQdrantHealth(), 8000, { connected: false, error: 'Qdrant check timed out' }),
      withTimeout(checkNeo4jHealth(forceRefresh), 10000, { connected: false, error: 'Neo4j check timed out (10s)' }),
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

    // FIX (breaker-audit #6): model circuit breakers — các model đang bị chặn
    // fail-fast kèm lý do (429-hard-block / timeout-hang) + thời điểm hết chặn.
    // getModelBlockBreakers() trước đây là dead-code (export nhưng 0 chỗ dùng)
    // → không có cách nào truy vấn breaker từ UI/API.
    const modelCircuitBreakers = getModelBlockBreakers()

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
      modelCircuitBreakers,
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
