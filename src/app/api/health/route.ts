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
import { getProviderDiagnostics, getDailyQuotaStatus, getModelBlockBreakers, getZenStatus } from '@/lib/llm'

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

  // (2026-09-27 TASK 33) z-ai-sdk provider ĐÃ GỠ BỎ toàn bộ theo user directive
  // ("bỏ luôn cả z-ai" — sdk chỉ tồn tại trong sandbox, không có trên máy local).

  // ━━ OpenCode Zen — LÕI DUY NHẤT cho agents/utility/extraction (Task 33) ━━
  const zenStatus = getZenStatus()
  // TASK 34 — model bị cache chặn free-tier (policy Zen ~25-26/09: model free
  // chặn oc_sk API key ở cả HTTP lẫn CLI; các cặp này tự skip → ZEN FAILOVER)
  const blockedNote = zenStatus.freeTierBlocked.length > 0
    ? ` · 🚫 ${zenStatus.freeTierBlocked.length} cặp model:transport bị chặn free-tier (cache TTL 15p → failover): ${zenStatus.freeTierBlocked.slice(0, 4).join(', ')}`
    : ''
  result.zen = {
    available: zenStatus.configured,
    model: zenStatus.models.join(' + '),
    active: zenStatus.configured,
    error: !zenStatus.configured ? 'No ZEN_API_KEY configured' : undefined,
    note: zenStatus.configured
      ? `${zenStatus.keyCount} key(s) · ${zenStatus.availableKeys} available · ${zenStatus.rateLimitedKeys} rate-limited · space-bunny-free (lõi chính — HTTP xoay key) + ling-3.1-flash-free / mimo-v2.6-flash-free / step-5-preview-free / longcat-2.5-preview-free / big-pickle (model free khác — qua CLI native, r72)${blockedNote}`
      : undefined,
  }

  // ━━ NVIDIA NIM — CHỈ còn lõi EMBED (Task 33) ━━
  result.nvidia = {
    available: hasNvidiaKeys,
    model: 'nvidia/nemotron-3-embed-1b (embed only)',
    active: hasNvidiaKeys,
    error: !hasNvidiaKeys ? 'No NVIDIA API keys configured (embed sẽ không chạy)' : undefined,
    note: hasNvidiaKeys ? 'CHỈ dùng cho lõi embed (generateEmbedding) — NIM đã gỡ khỏi tác vụ agents/utility/extraction (Task 33)' : undefined,
  }

  return result
}

// Auto-initialize Qdrant collections on first health check
const globalForInit = globalThis as unknown as { __qdrantInitialized?: boolean }
async function ensureQdrantInitialized() {
  if (!globalForInit.__qdrantInitialized) {
    globalForInit.__qdrantInitialized = true
    try {
      // ROUND-35 (B3): initializeCollections KHÔNG throw khi dim mismatch — nó
      // trả { documents, chunks, error }. Bản cũ log "initialized" thành công
      // cả khi result.chunks=false + error='dim-mismatch...' → thông điệp lừa
      // vận hành. Giờ log đúng kết quả thật.
      const res = await initializeCollections()
      if (res && (res.chunks === false || res.documents === false)) {
        console.warn(
          '[Health] Qdrant initialization issue:',
          res.error ?? `documents=${res.documents}, chunks=${res.chunks} (xem dim guard / TMO_QDRANT_ALLOW_DIM_RECREATE)`
        )
      } else {
        console.log('[Health] Qdrant collections initialized')
      }
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
    // ROUND-35 (B3): dim mismatch PHẢI kéo status xuống 'degraded' — bản cũ chỉ
    // thêm field dimMismatch vào JSON (P2-c) nhưng coreHealthy bỏ qua → đổi
    // embedding model sai dim là lỗi cấu hình chết (mọi upsert 400) mà health
    // vẫn xanh 'healthy' → operator không thấy đỏ đâu ngoài console FATAL.
    // Lưu ý: tmo-keepalive chỉ check HTTP status (luôn 200) nên không tạo vòng restart.
    const coreHealthy =
      qdrant.connected &&
      sqlite.connected &&
      qdrant.chunksCollection?.dimMismatch !== true
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
