/**
 * Shared LLM Calling Module for GraphRAG
 *
 * SINGLE PROVIDER architecture — NVIDIA NIM ONLY:
 *   NVIDIA NIM (4 keys × 4 docs = 16 max concurrent, auto mode)
 *
 * Architecture: NVIDIA NIM ONLY (no Mistral, Cerebras, OpenRouter)
 *   - 2 extraction cores: nemotron-3-ultra-550b, gpt-oss-120b
 *   - 4 agent/chat cores: kimi-k3 (primary), gpt-oss-120b, deepseek-v4-flash-0731, minimax-m3 (fallbacks)
 *   - glm-5.2 REMOVED 2026-08-25: NVIDIA NIM end-of-life 2026-08-21
 *   - Deprecated (404): kimi-k2.6, glm-5.1, minimax-m2.7, deepseek-v4-pro, qwen3.5-397b
 *
 * Key assignment (AUTO mode, least-loaded-first):
 *   - Each document gets a key (0-3, auto-assigned to least-loaded key)
 *   - Key N uses NVIDIA Key N (strict binding for rate limit isolation)
 *   - If Key N is rate-limited/exhausted → fallback to next available key
 *
 * Model rotation: Models within each group are tried in round-robin order
 *   so all models get usage, not just the first in the list.
 *
 * Token tracking: NVIDIA NIM (single provider)
 */

// ==================== TOKEN EVENT EMITTER (SSE REALTIME) ====================

import { EventEmitter } from 'events'

/** EventEmitter for real-time token updates (SSE).
 *  Emits 'token-update' event whenever addTokensUsed() or addTokensUsedByAgent() is called.
 *  The SSE endpoint /api/token-usage/stream subscribes to this emitter. */
export const tokenEmitter = new EventEmitter()
tokenEmitter.setMaxListeners(50) // Allow multiple SSE connections

/** Throttle SSE emission: max once per 500ms to avoid flooding clients.
 *  Token data is accumulated in-memory between emissions — no data loss. */
let lastEmitTime = 0
let emitTimer: ReturnType<typeof setTimeout> | null = null
const EMIT_THROTTLE_MS = 500

function emitTokenUpdate() {
  const now = Date.now()
  if (now - lastEmitTime >= EMIT_THROTTLE_MS) {
    lastEmitTime = now
    // Emit a snapshot of current in-memory data (non-blocking)
    const snapshot = {
      date: dailyTokenDate,
      tokens: dailyTokenCount,
      providers: { ...dailyTokensByProvider },
      slots: (() => { const r: Record<string, Record<number, number>> = {}; for (const [p, s] of Object.entries(dailyTokensByProviderSlot)) { r[p] = { ...s } }; return r })(),
      models: (() => { const r: Record<string, Record<string, number>> = {}; for (const [p, m] of Object.entries(dailyTokensByProviderModel)) { r[p] = { ...m } }; return r })(),
      agents: Object.entries(dailyTokensByAgent).filter(([k]) => k.startsWith(dailyTokenDate)).map(([, d]) => ({ ...d })),
    }
    tokenEmitter.emit('token-update', snapshot)
  } else if (!emitTimer) {
    // Schedule a delayed emission to ensure updates aren't lost
    emitTimer = setTimeout(() => {
      emitTimer = null
      lastEmitTime = Date.now()
      const snapshot = {
        date: dailyTokenDate,
        tokens: dailyTokenCount,
        providers: { ...dailyTokensByProvider },
        slots: (() => { const r: Record<string, Record<number, number>> = {}; for (const [p, s] of Object.entries(dailyTokensByProviderSlot)) { r[p] = { ...s } }; return r })(),
        models: (() => { const r: Record<string, Record<string, number>> = {}; for (const [p, m] of Object.entries(dailyTokensByProviderModel)) { r[p] = { ...m } }; return r })(),
        agents: Object.entries(dailyTokensByAgent).filter(([k]) => k.startsWith(dailyTokenDate)).map(([, d]) => ({ ...d })),
      }
      tokenEmitter.emit('token-update', snapshot)
    }, EMIT_THROTTLE_MS - (now - lastEmitTime))
  }
}

// ==================== TYPES ====================

export interface LLMResult {
  content: string
  provider: string
  model: string
  error?: string
  tokensUsed?: number /// Total tokens (prompt + completion) from API response
  /** Native function-calling tool_calls from the API response.
   *  Populated only when the caller passes `tools` in LLMCallOptions
   *  AND the model emits a tool_calls array. Empty/undefined otherwise. */
  tool_calls?: LLMToolCall[]
  /** OpenAI-style finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
   *  Useful for Phase 1c dual-mode logic (workflow-engine.ts). */
  finish_reason?: string | null
}

/** OpenAI-style tool/function schema passed to the LLM via the `tools` API param.
 *  Matches the shape of ToolDefinition in code-team/tool-executor.ts —
 *  re-declared here to avoid circular imports (llm.ts is a leaf dependency). */
export interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }
}

/** Parsed tool_call from LLM API response. */
export interface LLMToolCall {
  id: string                 /// server-assigned id (e.g. "call_abc123")
  type: 'function'
  function: {
    name: string             /// tool name
    arguments: string       /// JSON string — caller must JSON.parse
  }
}

export interface LLMCallOptions {
  temperature?: number
  maxTokens?: number
  agentId?: string      /// AgentProfile.id — for per-agent token tracking
  agentName?: string    /// Agent name — denormalized for quick display
  /** Phase 1c: Native function-calling tool schemas.
   *  When provided, the NIM API call includes `tools` + `tool_choice`.
   *  When undefined, the request body is unchanged (backward compatible). */
  tools?: LLMTool[]
  /** 'auto' (default when tools provided) | 'none' | 'required' | specific function selector.
   *  Ignored when `tools` is undefined. */
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  /** Phase 4 SMOLAB Prop 11' — explicit model override (e.g. 'openai/gpt-oss-120b').
   *  When provided, callLLM() calls ONLY this NVIDIA NIM model (round-robin across
   *  all 4 keys) instead of the rotating chat pool. No rotation fallback — if the
   *  model fails, the error result is returned (callers decide how to fail-open).
   *  Backward compatible: undefined (default) = current rotation behavior. */
  model?: string
}

// ==================== CONSTANTS ====================

export const MAX_KEYS = 4

/** Maximum documents each key can process concurrently.
 *  With 4 keys × 4 docs = 16 max concurrent documents (auto mode). */
export const MAX_DOCS_PER_KEY = 4

/** Absolute maximum concurrent documents across all keys (auto mode). */
export const MAX_TOTAL_CONCURRENT = MAX_KEYS * MAX_DOCS_PER_KEY

/** Single provider architecture — NVIDIA NIM ONLY */
const PROVIDER_COUNT = 1
const PROVIDER_NAMES = ['NVIDIA'] as const

/** Key assignment mode — no more slot mode.
 *  Each of the 4 API keys can handle up to 4 documents concurrently.
 *  Auto mode: documents are assigned to the key with the fewest active docs.
 *  Max concurrent: 4 keys × 4 docs = 16 documents. */
export const KEY_ASSIGNMENT_MODE = 'auto' as const

// ==================== PROVIDER ROTATION (simplified — single provider) ====================

/** With a single provider (NVIDIA), rotation is trivial — always use index 0.
 *  Kept for API compatibility with callLLMSlot/callLLM signatures. */
let providerRotationCounter = 0

function getNextProviderStart(): number {
  const start = providerRotationCounter % PROVIDER_COUNT
  providerRotationCounter++
  return start
}

// ==================== MODEL ROTATION ====================

/** Per-provider model rotation counters.
 *  Each provider starts its model list at a different offset each call,
 *  so all models within a provider get usage, not just the first one.
 */
const modelRotationCounters: Record<string, number> = {
  NVIDIA: 0,
}

/** Get a rotated copy of a model list for a provider.
 *  The starting model changes each call so all models get used.
 *
 *  NOTE: For EXTRACTION models, rotation is DISABLED (user Option C — 2026-08-21).
 *  nemotron-3-ultra-550b is ALWAYS tried first because it produces higher-quality
 *  extraction. gpt-oss-120b is only used as fallback when nemotron returns 429/timeout.
 *  This trades ~15x slower response time for better extraction quality.
 */
function getRotatedModels(provider: string, models: string[]): string[] {
  // EXTRACTION models: no rotation — always try primary (nemotron-550b) first
  // Compare by reference — if it's the extraction list, skip rotation
  if (models === NVIDIA_EXTRACTION_MODELS) {
    return models // Always [nemotron-550b, gpt-oss-120b]
  }
  // AGENT/CHAT models (MODEL POLICY 2026-08-25): no rotation — kimi-k3 is the
  // DEFAULT for every agent; the others are sequential failover backups
  // (not load-balanced), so the order must stay fixed.
  if (models === NVIDIA_AGENT_MODELS) {
    return models // Always [kimi-k3, gpt-oss-120b, deepseek, minimax]
  }
  // Legacy lists: rotate as before
  const offset = modelRotationCounters[provider] % models.length
  modelRotationCounters[provider]++
  if (offset === 0) return models // No rotation needed
  return [...models.slice(offset), ...models.slice(0, offset)]
}

/** NVIDIA NIM EXTRACTION models (4 keys × 4 docs, no daily cap)
 *  CHÍNH SÁCH: NVIDIA NIM chỉ sử dụng 2 lõi này cho trích xuất tài liệu.
 *  Các lõi khác (gpt-oss-120b, deepseek-v4-flash, minimax-m3) chỉ dùng cho agent/chat.
 *
 *  nvidia/nemotron-3-ultra-550b-a55b: 550B MoE (55B active), mạnh nhất ✓ VERIFIED 2026-08-21
 *  openai/gpt-oss-120b: 120B MoE, fallback khi 550b bị rate-limit ✓ VERIFIED 2026-08-21
 *
 *  Đã bỏ: llama-3.1-nemotron-ultra-253b-v1 (404 NOT FOUND — deprecated 2026-08-21)
 *  Đã bỏ: nemotron-4-340b-instruct (404 NOT FOUND — deprecated 2026-08-21)
 *  Đã bỏ: meta/llama-3.3-70b-instruct (vẫn hoạt động nhưng chất lượng trích xuất kém hơn 550b)
 */
const NVIDIA_EXTRACTION_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'openai/gpt-oss-120b',
]

/** NVIDIA NIM AGENT/CHAT models — MODEL POLICY 2026-08-25 (user request):
 *  kimi-k3 là MẶC ĐỊNH cho tất cả agents; các lõi khác là BACKUP theo thứ tự
 *  (gpt-oss-120b → deepseek-v4-flash → minimax-m3) — chỉ dùng khi kimi-k3
 *  fail/rate-limit. Không rotation round-robin (backup = failover, không phải
 *  load-balance) — see getRotatedModels(). */
const NVIDIA_AGENT_MODELS = [
  'moonshotai/kimi-k3',
  'openai/gpt-oss-120b',
  'deepseek-ai/deepseek-v4-flash-0731',
  'minimaxai/minimax-m3',
]

/** NVIDIA NIM ALL models (2 extraction + 3 agent/chat)
 *  Model IDs verified 2026-08-21 via actual completion calls against integrate.api.nvidia.com
 *  Deprecated (404): kimi-k2.6, glm-5.1, minimax-m2.7, deepseek-v4-pro, qwen3.5-397b
 */
const NVIDIA_MODELS = [
  // Extraction models (2 lõi trích xuất tài liệu)
  'nvidia/nemotron-3-ultra-550b-a55b',
  'openai/gpt-oss-120b',
  // Agent/Chat models (kimi-k3 primary + 3 fallbacks — verified working 2026-08-21)
  'moonshotai/kimi-k3',
  'deepseek-ai/deepseek-v4-flash-0731',
  'minimaxai/minimax-m3',
]

/** NVIDIA NIM ALL models (2 extraction + 3 agent/chat) */

// ==================== DAILY TOKEN TRACKING ====================

/** In-memory daily token counter — persisted to DB periodically */
let dailyTokenCount = 0
let dailyTokenDate = '' // "YYYY-MM-DD"
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_INTERVAL_MS = 10_000 // Persist to DB every 10 seconds — reduced from 30s to minimize data loss on dev server hot-reloads
let lastPersistTime = 0 // Track last persist time for debounced immediate persist
const IMMEDIATE_PERSIST_MIN_INTERVAL_MS = 3_000 // Minimum 3s between immediate persists (debounce)

/** In-memory per-provider daily token counters — persisted alongside total */
const dailyTokensByProvider: Record<string, number> = {} // provider → tokens

/** In-memory per-provider-per-slot daily token counters — persisted alongside total */
const dailyTokensByProviderSlot: Record<string, Record<number, number>> = {} // provider → { slotIndex → tokens }

/** In-memory per-provider-per-model daily token counters — tracks tokens per model */
const dailyTokensByProviderModel: Record<string, Record<string, number>> = {} // provider → { modelName → tokens }

/** In-memory per-agent daily token counters — tracks tokens per agent per provider+model
 *  Key: "date:agentId:provider:model" */
const dailyTokensByAgent: Record<string, {
  agentId: string
  agentName: string
  provider: string
  model: string
  tokens: number
  inputTokens: number
  outputTokens: number
}> = {}

// ==================== DIRTY TRACKING (avoid unnecessary DB writes) ====================

/** Track which in-memory values have changed since the last persist.
 *  Only dirty records are written to SQLite, reducing I/O by ~80%. */
let totalTokensDirty = false
const providerDirty: Set<string> = new Set()     // Set of provider names that changed
const slotDirty: Set<string> = new Set()         // Set of "provider:slot" keys that changed
const modelDirty: Set<string> = new Set()        // Set of "provider:model" keys that changed
const agentDirty: Set<string> = new Set()        // Set of "agentId:provider:model" keys that changed
// NOTE: No remote sync needed — SQLite is the sole persistent store for token data

/** Cached db reference — avoids repeated dynamic imports that can create
 *  separate PrismaClient instances in Next.js dev mode with Turbopack.
 *  This is the root cause of the intermittent "Unable to open the database file"
 *  error: each dynamic import might compile to a separate module context,
 *  creating a new PrismaClient that conflicts with the existing one.
 */
let cachedDb: InstanceType<typeof import('@/lib/db')['db']> | null = null

async function getDb() {
  if (!cachedDb) {
    const { db } = await import('@/lib/db')
    cachedDb = db
  }
  return cachedDb
}

/** Check if an error is a transient SQLite error that can be retried */
function isTransientDbError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('Unable to open') ||
    err.message.includes('SQLITE_BUSY') ||
    err.message.includes('SQLITE_CANTOPEN') ||
    err.message.includes('Error code 14') ||
    err.message.includes('database is locked') ||
    err.message.includes('Connection is closed') ||
    err.message.includes('prepared statement failed')
  )
}

/** Retry a database operation with exponential backoff.
 *  SQLite has a single-writer limitation — concurrent writes from different
 *  PrismaClient instances (caused by Turbopack hot-reloading) can fail with
 *  SQLITE_CANTOPEN (Error code 14). Retrying with a delay gives the lock
 *  time to release.
 *
 *  Also resets the cachedDb on transient errors — sometimes the cached
 *  PrismaClient becomes stale after a hot-reload, and getting a fresh
 *  reference fixes the issue.
 */
async function retryDbOp<T>(
  op: (db: Awaited<ReturnType<typeof getDb>>) => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const db = await getDb()
      return await op(db)
    } catch (err) {
      lastErr = err
      if (!isTransientDbError(err) || attempt === maxRetries) break
      // Reset cachedDb on transient errors — the PrismaClient might be stale
      // after a Turbopack hot-reload, and getting a fresh reference fixes it.
      cachedDb = null
      const delay = baseDelayMs * Math.pow(2, attempt)
      console.log(`[TokenTracker] DB busy, retry ${attempt + 1}/${maxRetries} in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastErr
}

/** User timezone for daily token reset.
 *  The server runs in UTC, but the user is in Vietnam (ICT, UTC+7).
 *  Token counters must reset at midnight USER time, not midnight UTC.
 *  Without this fix, tokens would reset at 07:00 AM Vietnam time instead of 00:00. */
const USER_TIMEZONE = 'Asia/Ho_Chi_Minh'

function getTodayDateStr(): string {
  // Use Intl.DateTimeFormat to get the correct date in the user's timezone
  // This ensures token counters reset at midnight in Vietnam (ICT), not UTC
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: USER_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const year = parts.find(p => p.type === 'year')!.value
  const month = parts.find(p => p.type === 'month')!.value
  const day = parts.find(p => p.type === 'day')!.value
  return `${year}-${month}-${day}`
}

async function initDailyTokens(): Promise<void> {
  try {
    const today = getTodayDateStr()
    const dateChanged = dailyTokenDate && dailyTokenDate !== today

    // If the date changed, persist the previous day's data BEFORE resetting
    if (dateChanged) {
      const oldDate = dailyTokenDate
      const oldCount = dailyTokenCount
      const oldProviders = { ...dailyTokensByProvider }
      const oldSlots: Record<string, Record<number, number>> = {}
      for (const [p, s] of Object.entries(dailyTokensByProviderSlot)) {
        oldSlots[p] = { ...s }
      }
      // Snapshot model + agent data too (BUG FIX)
      const oldModels: Record<string, Record<string, number>> = {}
      for (const [p, ms] of Object.entries(dailyTokensByProviderModel)) {
        oldModels[p] = { ...ms }
      }
      const oldAgents: Record<string, typeof dailyTokensByAgent[string]> = {}
      for (const [k, v] of Object.entries(dailyTokensByAgent)) {
        oldAgents[k] = { ...v }
      }
      console.log(`[TokenTracker] Date changed in init (${oldDate} → ${today}), persisting previous day data first`)
      await persistDailyTokens(oldDate, oldCount, oldProviders, oldSlots, oldModels, oldAgents).catch(() => {})

      // Reset in-memory counters for the new day
      dailyTokenCount = 0
      for (const key of Object.keys(dailyTokensByProvider)) {
        delete dailyTokensByProvider[key]
      }
      for (const key of Object.keys(dailyTokensByProviderSlot)) {
        delete dailyTokensByProviderSlot[key]
      }
      for (const key of Object.keys(dailyTokensByProviderModel)) {
        delete dailyTokensByProviderModel[key]
      }
      for (const key of Object.keys(dailyTokensByAgent)) {
        delete dailyTokensByAgent[key]
      }
    }

    // === SQLITE-ONLY INIT ===
    // Token tracking is now SQLite-only (no remote sync)
    // Architecture: In-memory → SQLite (every 30s)
    const record = await retryDbOp(db => db.dailyTokenUsage.findUnique({ where: { date: today } }))
    const dbTokens = record?.tokens ?? 0

    // Load per-provider data from SQLite for today
    const dbProviderRecords = await retryDbOp(db => db.dailyTokenByProvider.findMany({ where: { date: today } }))
    for (const rec of dbProviderRecords) {
      if (dailyTokensByProvider[rec.provider] === undefined) {
        dailyTokensByProvider[rec.provider] = rec.tokens
      } else {
        dailyTokensByProvider[rec.provider] = Math.max(dailyTokensByProvider[rec.provider], rec.tokens)
      }
    }

    // Load per-provider-per-slot data from SQLite for today
    const dbSlotRecords = await retryDbOp(db => db.dailyTokenByProviderSlot.findMany({ where: { date: today } }))
    for (const rec of dbSlotRecords) {
      if (!dailyTokensByProviderSlot[rec.provider]) {
        dailyTokensByProviderSlot[rec.provider] = {}
      }
      if (dailyTokensByProviderSlot[rec.provider][rec.slot] === undefined) {
        dailyTokensByProviderSlot[rec.provider][rec.slot] = rec.tokens
      } else {
        dailyTokensByProviderSlot[rec.provider][rec.slot] = Math.max(
          dailyTokensByProviderSlot[rec.provider][rec.slot],
          rec.tokens
        )
      }
    }

    // Load per-provider-per-model data from SQLite for today
    const dbModelRecords = await retryDbOp(db => db.dailyTokenByProviderModel.findMany({ where: { date: today } }))
    for (const rec of dbModelRecords) {
      if (!dailyTokensByProviderModel[rec.provider]) {
        dailyTokensByProviderModel[rec.provider] = {}
      }
      if (dailyTokensByProviderModel[rec.provider][rec.model] === undefined) {
        dailyTokensByProviderModel[rec.provider][rec.model] = rec.tokens
      } else {
        dailyTokensByProviderModel[rec.provider][rec.model] = Math.max(
          dailyTokensByProviderModel[rec.provider][rec.model],
          rec.tokens
        )
      }
    }

    // Load per-agent data from SQLite for today
    const dbAgentRecords = await retryDbOp(db => db.dailyTokenByAgent.findMany({ where: { date: today } }))
    for (const rec of dbAgentRecords) {
      const key = `${today}:${rec.agentId}:${rec.provider}:${rec.model}`
      if (!dailyTokensByAgent[key]) {
        dailyTokensByAgent[key] = {
          agentId: rec.agentId,
          agentName: rec.agentName,
          provider: rec.provider,
          model: rec.model,
          tokens: rec.tokens,
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
        }
      } else {
        dailyTokensByAgent[key].tokens = Math.max(dailyTokensByAgent[key].tokens, rec.tokens)
        dailyTokensByAgent[key].inputTokens = Math.max(dailyTokensByAgent[key].inputTokens, rec.inputTokens)
        dailyTokensByAgent[key].outputTokens = Math.max(dailyTokensByAgent[key].outputTokens, rec.outputTokens)
      }
    }

    // CRITICAL: Use the MAX of in-memory and SQLite
    const maxFromSources = dbTokens
    if (dateChanged) {
      dailyTokenCount = maxFromSources
    } else {
      dailyTokenCount = Math.max(dailyTokenCount, maxFromSources)
    }
    dailyTokenDate = today
    console.log(`[TokenTracker] Initialized daily tokens: ${dailyTokenCount} (SQLite: ${dbTokens}, dateChanged: ${dateChanged}) for ${today}`)
  } catch (err) {
    console.error('[TokenTracker] Failed to init daily tokens:', err)
    if (!dailyTokenDate) {
      dailyTokenCount = dailyTokenCount || 0
      dailyTokenDate = getTodayDateStr()
    }
  }
}

export function addTokensUsed(tokens: number, provider?: string, slotIndex?: number, model?: string): void {
  const today = getTodayDateStr()
  if (dailyTokenDate && dailyTokenDate !== today) {
    // Date changed — SNAPSHOT the previous day's data BEFORE resetting
    // This prevents the race condition where persistDailyTokens reads
    // the already-reset dailyTokenDate/count.
    const oldDate = dailyTokenDate
    const oldCount = dailyTokenCount
    const oldProviders = { ...dailyTokensByProvider }
    const oldSlots: Record<string, Record<number, number>> = {}
    for (const [p, s] of Object.entries(dailyTokensByProviderSlot)) {
      oldSlots[p] = { ...s }
    }
    // Snapshot model + agent data too (BUG FIX: these were lost before because
    // persistDailyTokens read from module-level vars which were already reset)
    const oldModels: Record<string, Record<string, number>> = {}
    for (const [p, ms] of Object.entries(dailyTokensByProviderModel)) {
      oldModels[p] = { ...ms }
    }
    const oldAgents: Record<string, typeof dailyTokensByAgent[string]> = {}
    for (const [k, v] of Object.entries(dailyTokensByAgent)) {
      oldAgents[k] = { ...v }
    }

    console.log(`[TokenTracker] Date changed (${oldDate} → ${today}), persisting previous day data first`)
    // Fire-and-forget persist of previous day with ALL SNAPSHOT values
    persistDailyTokens(oldDate, oldCount, oldProviders, oldSlots, oldModels, oldAgents).catch(() => {})

    // NOW reset for the new day
    console.log(`[TokenTracker] Resetting counter for new day: ${today}`)
    dailyTokenCount = 0
    dailyTokenDate = today
    // Reset per-provider counters
    for (const key of Object.keys(dailyTokensByProvider)) {
      delete dailyTokensByProvider[key]
    }
    // Reset per-provider-per-slot counters
    for (const key of Object.keys(dailyTokensByProviderSlot)) {
      delete dailyTokensByProviderSlot[key]
    }
    // Reset per-provider-per-model counters
    for (const key of Object.keys(dailyTokensByProviderModel)) {
      delete dailyTokensByProviderModel[key]
    }
    // Reset per-agent counters
    for (const key of Object.keys(dailyTokensByAgent)) {
      delete dailyTokensByAgent[key]
    }
  } else if (!dailyTokenDate) {
    // First call ever — set the date
    dailyTokenDate = today
  }
  dailyTokenCount += tokens
  // Track per-provider tokens
  if (provider) {
    dailyTokensByProvider[provider] = (dailyTokensByProvider[provider] || 0) + tokens
    // Track per-provider-per-slot tokens
    if (slotIndex !== undefined && slotIndex >= 0) {
      if (!dailyTokensByProviderSlot[provider]) {
        dailyTokensByProviderSlot[provider] = {}
      }
      dailyTokensByProviderSlot[provider][slotIndex] = (dailyTokensByProviderSlot[provider][slotIndex] || 0) + tokens
    }
    // Track per-provider-per-model tokens
    if (model) {
      if (!dailyTokensByProviderModel[provider]) {
        dailyTokensByProviderModel[provider] = {}
      }
      dailyTokensByProviderModel[provider][model] = (dailyTokensByProviderModel[provider][model] || 0) + tokens
    }
  }
  // Mark dirty flags for the changed records
  totalTokensDirty = true
  if (provider) {
    providerDirty.add(provider)
    if (slotIndex !== undefined && slotIndex >= 0) {
      slotDirty.add(`${provider}:${slotIndex}`)
    }
    if (model) {
      modelDirty.add(`${provider}:${model}`)
    }
  }
  if (!persistTimer) {
    persistTimer = setTimeout(async () => {
      persistTimer = null
      await persistDailyTokens()
    }, PERSIST_INTERVAL_MS)
  }

  // DEBOUNCED IMMEDIATE PERSIST: For tokens > 500 (non-trivial LLM calls),
  // schedule an immediate persist 3 seconds after the last token addition.
  // This ensures token data is saved to SQLite quickly, reducing data loss
  // on dev server hot-reloads which can happen at any time.
  if (tokens > 500) {
    const now = Date.now()
    if (now - lastPersistTime > IMMEDIATE_PERSIST_MIN_INTERVAL_MS) {
      setTimeout(async () => {
        if (Date.now() - lastPersistTime > IMMEDIATE_PERSIST_MIN_INTERVAL_MS) {
          await persistDailyTokens().catch(() => {})
        }
      }, IMMEDIATE_PERSIST_MIN_INTERVAL_MS)
    }
  }

  // Emit SSE event for real-time frontend updates
  emitTokenUpdate()
}

/** Add per-agent token usage to in-memory counters.
 *  Called alongside addTokensUsed() when agentId is available. */
export function addTokensUsedByAgent(
  totalTokens: number,
  inputTokens: number,
  outputTokens: number,
  provider: string,
  model: string,
  agentId: string,
  agentName: string
): void {
  const today = getTodayDateStr()
  const key = `${today}:${agentId}:${provider}:${model}`
  const existing = dailyTokensByAgent[key]
  if (existing) {
    existing.tokens += totalTokens
    existing.inputTokens += inputTokens
    existing.outputTokens += outputTokens
  } else {
    dailyTokensByAgent[key] = {
      agentId,
      agentName,
      provider,
      model,
      tokens: totalTokens,
      inputTokens,
      outputTokens,
    }
  }
  agentDirty.add(`${agentId}:${provider}:${model}`)
  // Trigger persist timer if not already running
  if (!persistTimer) {
    persistTimer = setTimeout(async () => {
      persistTimer = null
      await persistDailyTokens()
    }, PERSIST_INTERVAL_MS)
  }

  // Emit SSE event for real-time frontend updates
  emitTokenUpdate()
}

async function persistDailyTokens(
  targetDate?: string,
  targetCount?: number,
  targetProviders?: Record<string, number>,
  targetSlots?: Record<string, Record<number, number>>,
  targetModels?: Record<string, Record<string, number>>,
  targetAgents?: Record<string, { agentId: string; agentName: string; provider: string; model: string; tokens: number; inputTokens: number; outputTokens: number }>
): Promise<void> {
  // Use provided values (for date-change persist) or current in-memory values
  const date = targetDate || dailyTokenDate
  const count = targetCount !== undefined ? targetCount : dailyTokenCount
  const providers = targetProviders || dailyTokensByProvider
  const slots = targetSlots || dailyTokensByProviderSlot
  const models = targetModels || dailyTokensByProviderModel
  const agents = targetAgents || dailyTokensByAgent

  if (!date) return // Nothing to persist

  // For forced persists (date-change, flush), ignore dirty tracking — write everything
  const isForcedPersist = targetDate !== undefined || targetCount !== undefined
  const hasDirtyData = isForcedPersist || totalTokensDirty || providerDirty.size > 0 || slotDirty.size > 0 || modelDirty.size > 0 || agentDirty.size > 0

  if (!hasDirtyData) {
    // No changes since last persist — skip entirely (saves ~20 SQL queries per cycle)
    return
  }

  try {
    // === PERSIST TO SQLITE (local cache) ===
    // Only write total if dirty
    if (isForcedPersist || totalTokensDirty) {
      await retryDbOp(db => db.dailyTokenUsage.upsert({
        where: { date },
        update: { tokens: count },
        create: { date, tokens: count },
      }))
    }
    // Persist per-provider token counts — only dirty providers
    for (const [provider, tokens] of Object.entries(providers)) {
      if (!isForcedPersist && !providerDirty.has(provider)) continue // Skip unchanged
      try {
        await retryDbOp(db => db.dailyTokenByProvider.upsert({
          where: { date_provider: { date, provider } },
          update: { tokens },
          create: { date, provider, tokens },
        }))
      } catch (err) {
        if (!isTransientDbError(err)) {
          console.error(`[TokenTracker] Failed to persist provider tokens for ${provider}:`, err)
        }
      }
    }
    // Persist per-provider-per-slot token counts — only dirty slots
    for (const [provider, providerSlots] of Object.entries(slots)) {
      for (const [slotStr, tokens] of Object.entries(providerSlots)) {
        const slot = parseInt(slotStr, 10)
        const dirtyKey = `${provider}:${slot}`
        if (!isForcedPersist && !slotDirty.has(dirtyKey)) continue // Skip unchanged
        try {
          await retryDbOp(db => db.dailyTokenByProviderSlot.upsert({
            where: { date_provider_slot: { date, provider, slot } },
            update: { tokens },
            create: { date, provider, slot, tokens },
          }))
        } catch (err) {
          if (!isTransientDbError(err)) {
            console.error(`[TokenTracker] Failed to persist slot tokens for ${provider} slot ${slot}:`, err)
          }
        }
      }
    }

    // Persist per-provider-per-model token counts — only dirty models
    for (const [provider, providerModels] of Object.entries(models)) {
      for (const [modelName, tokens] of Object.entries(providerModels)) {
        const dirtyKey = `${provider}:${modelName}`
        if (!isForcedPersist && !modelDirty.has(dirtyKey)) continue // Skip unchanged
        try {
          await retryDbOp(db => db.dailyTokenByProviderModel.upsert({
            where: { date_provider_model: { date, provider, model: modelName } },
            update: { tokens },
            create: { date, provider, model: modelName, tokens },
          }))
        } catch (err) {
          if (!isTransientDbError(err)) {
            console.error(`[TokenTracker] Failed to persist model tokens for ${provider}/${modelName}:`, err)
          }
        }
      }
    }

    // Persist per-agent token counts — only dirty agents
    for (const [key, agentData] of Object.entries(agents)) {
      // Key format: "date:agentId:provider:model" — check date matches
      if (!key.startsWith(date)) continue
      const dirtyKey = `${agentData.agentId}:${agentData.provider}:${agentData.model}`
      if (!isForcedPersist && !agentDirty.has(dirtyKey)) continue // Skip unchanged
      try {
        await retryDbOp(db => db.dailyTokenByAgent.upsert({
          where: {
            date_agentId_provider_model: {
              date,
              agentId: agentData.agentId,
              provider: agentData.provider,
              model: agentData.model,
            },
          },
          update: {
            tokens: agentData.tokens,
            inputTokens: agentData.inputTokens,
            outputTokens: agentData.outputTokens,
            agentName: agentData.agentName, // Update name in case it changed
          },
          create: {
            date,
            agentId: agentData.agentId,
            agentName: agentData.agentName,
            provider: agentData.provider,
            model: agentData.model,
            tokens: agentData.tokens,
            inputTokens: agentData.inputTokens,
            outputTokens: agentData.outputTokens,
          },
        }))
      } catch (err) {
        if (!isTransientDbError(err)) {
          console.error(`[TokenTracker] Failed to persist agent tokens for ${agentData.agentName}/${agentData.provider}/${agentData.model}:`, err)
        }
      }
    }

    // Clear dirty flags after successful SQLite persist
    totalTokensDirty = false
    providerDirty.clear()
    slotDirty.clear()
    modelDirty.clear()
    agentDirty.clear()

    // Update last persist time for debounced immediate persist
    lastPersistTime = Date.now()

    // === SQLITE-ONLY PERSIST ===
    // Token data is stored in SQLite only — no remote sync needed
  } catch (err) {
    if (!isTransientDbError(err)) {
      console.error('[TokenTracker] Failed to persist daily tokens:', err)
    } else {
      console.warn('[TokenTracker] DB persist skipped (SQLite lock) — will retry next cycle')
    }
  }
}

/** Flush in-memory token data to SQLite immediately.
 *  Called on graceful shutdown (SIGINT/SIGTERM) and before hot-reload. */
export async function flushTokenData(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (dailyTokenDate && dailyTokenCount > 0) {
    console.log(`[TokenTracker] Flushing token data: ${dailyTokenCount} tokens for ${dailyTokenDate}`)
    await persistDailyTokens()
  }
}

// ==================== GRACEFUL SHUTDOWN ====================
// Ensure token data is persisted before the process exits.
// Without this, in-memory data is lost on dev server restart/hot-reload.

// FIX (listener leak on hot reload): the guard was module-scope, so every
// re-evaluation of llm.ts during dev hot-reload registered 3 MORE process
// listeners (SIGINT/SIGTERM/beforeExit) referencing dead module state —
// Node emits MaxListenersExceededWarning after ~10 reloads. The globalThis
// guard keeps exactly one registration alive across reloads.
const globalForTokenShutdown = globalThis as unknown as { __tokenShutdownRegistered?: boolean }

export function registerTokenShutdownHandlers(): void {
  if (globalForTokenShutdown.__tokenShutdownRegistered) return
  globalForTokenShutdown.__tokenShutdownRegistered = true

  const flushAndExit = async (signal: string) => {
    console.log(`[TokenTracker] Received ${signal}, flushing token data...`)
    try {
      await flushTokenData()
    } catch (err) {
      console.error('[TokenTracker] Failed to flush on shutdown:', err)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => flushAndExit('SIGINT'))
  process.on('SIGTERM', () => flushAndExit('SIGTERM'))
  process.on('beforeExit', async () => {
    try {
      await flushTokenData()
    } catch {
      // Best effort
    }
  })
}

// Auto-register shutdown handlers on module load
registerTokenShutdownHandlers()

export async function getDailyTokenUsage(): Promise<{ date: string; tokens: number }> {
  const today = getTodayDateStr()
  if (dailyTokenDate !== today) {
    await initDailyTokens()
  }
  return { date: dailyTokenDate, tokens: dailyTokenCount }
}

/** Get current in-memory per-provider token breakdown for today */
export function getDailyTokensByProvider(): Record<string, number> {
  return { ...dailyTokensByProvider }
}

/** Get current in-memory per-provider-per-slot token breakdown for today */
export function getDailyTokensByProviderSlot(): Record<string, Record<number, number>> {
  // Deep clone to prevent mutation
  const result: Record<string, Record<number, number>> = {}
  for (const [provider, slots] of Object.entries(dailyTokensByProviderSlot)) {
    result[provider] = { ...slots }
  }
  return result
}

/** Get current in-memory per-provider-per-model token breakdown for today */
export function getDailyTokensByProviderModel(): Record<string, Record<string, number>> {
  // Deep clone to prevent mutation
  const result: Record<string, Record<string, number>> = {}
  for (const [provider, models] of Object.entries(dailyTokensByProviderModel)) {
    result[provider] = { ...models }
  }
  return result
}

/** Get current in-memory per-agent token breakdown for today */
export function getDailyTokensByAgent(): Array<{
  agentId: string
  agentName: string
  provider: string
  model: string
  tokens: number
  inputTokens: number
  outputTokens: number
}> {
  const today = getTodayDateStr()
  return Object.entries(dailyTokensByAgent)
    .filter(([key]) => key.startsWith(today))
    .map(([, data]) => ({ ...data }))
}

/** Reset all in-memory daily token counters to 0 for the current day.
 *  Also updates the DB record to 0 and deletes all provider/slot records for today.
 */
export async function resetDailyTokens(): Promise<void> {
  const today = getTodayDateStr()

  // Reset in-memory counters
  dailyTokenCount = 0
  dailyTokenDate = today

  // Clear per-provider counters
  for (const key of Object.keys(dailyTokensByProvider)) {
    delete dailyTokensByProvider[key]
  }

  // Clear per-provider-per-slot counters
  for (const key of Object.keys(dailyTokensByProviderSlot)) {
    delete dailyTokensByProviderSlot[key]
  }

  // Clear per-provider-per-model counters
  for (const key of Object.keys(dailyTokensByProviderModel)) {
    delete dailyTokensByProviderModel[key]
  }

  // Clear per-agent counters
  for (const key of Object.keys(dailyTokensByAgent)) {
    delete dailyTokensByAgent[key]
  }

  // Update SQLite record for today to 0
  try {
    await retryDbOp(db => db.dailyTokenUsage.upsert({
      where: { date: today },
      update: { tokens: 0 },
      create: { date: today, tokens: 0 },
    }))

    // Delete all provider records for today
    await retryDbOp(db => db.dailyTokenByProvider.deleteMany({
      where: { date: today },
    }))

    // Delete all provider-slot records for today
    await retryDbOp(db => db.dailyTokenByProviderSlot.deleteMany({
      where: { date: today },
    }))

    // Delete all provider-model records for today
    await retryDbOp(db => db.dailyTokenByProviderModel.deleteMany({
      where: { date: today },
    }))

    // Delete all agent records for today
    await retryDbOp(db => db.dailyTokenByAgent.deleteMany({
      where: { date: today },
    }))

    console.log(`[TokenTracker] Reset daily tokens to 0 for ${today} (SQLite)`)
  } catch (err) {
    console.error('[TokenTracker] Failed to reset daily tokens in SQLite:', err)
  }

  // Token tracking is SQLite-only — no remote reset needed

  // Emit SSE event so frontend knows counters were reset
  emitTokenUpdate()
}

// Force-persist tokens (called when a document finishes processing)
export async function flushTokenCount(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  await persistDailyTokens()
}

initDailyTokens().catch(() => {})

// ==================== KEY POOL (AUTO MODE) ====================

// ==================== KEY PERSISTENCE & RECOVERY ====================

/**
 * On server restart, in-memory keyAssignments are lost.
 * This function recovers by:
 *   1. Querying Qdrant for documents in active processing states
 *   2. Re-assigning them to keys with available capacity
 *   3. Persisting key assignments to SQLite for durability
 *
 * Auto mode: Each of the 4 keys handles up to 4 docs (max 16 concurrent).
 * This is called on module init and can be called manually via API.
 */
export async function recoverKeys(): Promise<{
  recovered: number
  keys: Array<{ keyIndex: number; docIds: string[] }>
}> {
  try {
    const { listDocuments, updateDocumentStatus } = await import('@/lib/qdrant')

    // Find documents that are actively being processed (stuck in transitional states).
    const activeStatuses = ['extracting', 'parsing', 'chunked']
    const allActiveDocs: Array<{ id: string; payload: { status: string; updated_at: string; title?: string; [key: string]: unknown } }> = []

    for (const status of activeStatuses) {
      try {
        const result = await listDocuments({
          status,
          limit: MAX_TOTAL_CONCURRENT,
          orderBy: 'updated_at',
          orderDir: 'desc',
        })
        allActiveDocs.push(...result.documents)
      } catch (err) {
        console.warn(`[KeyPool] Recovery: failed to query status '${status}':`, err instanceof Error ? err.message : String(err))
      }
    }

    // Deduplicate by doc ID
    const seenIds = new Set<string>()
    const activeDocs = allActiveDocs.filter(d => {
      if (seenIds.has(d.id)) return false
      seenIds.add(d.id)
      return true
    })

    if (activeDocs.length === 0) {
      console.log('[KeyPool] No active documents to recover from Qdrant')
      return { recovered: 0, keys: getKeyStatus() }
    }

    console.log(`[KeyPool] Found ${activeDocs.length} docs in active processing states (${activeStatuses.join('/')})`)

    initKeyAssignments()
    let recovered = 0
    let staleReset = 0
    for (const doc of activeDocs) {
      // Only assign if not already assigned to a key
      const alreadyAssigned = keyAssignments.some(k => k.docIds.includes(doc.id))
      if (alreadyAssigned) continue

      // Find a key with available capacity (auto mode: fewest docs first)
      const availableKey = keyAssignments
        .filter(k => k.docIds.length < MAX_DOCS_PER_KEY)
        .sort((a, b) => a.docIds.length - b.docIds.length)[0]
      if (!availableKey) break  // All keys at capacity

      // Check if doc was updated recently (within 5 min)
      const updatedAt = new Date(doc.payload.updated_at).getTime()
      const isRecent = Date.now() - updatedAt < 5 * 60 * 1000

      if (!isRecent) {
        console.log(`[KeyPool] Recovery: doc ${doc.id.slice(0, 8)}... (${doc.payload.status}) is stale (updated ${Math.round((Date.now() - updatedAt) / 60000)}m ago) — resetting to 'partial'`)
        await updateDocumentStatus(doc.id, { status: 'partial' })
        staleReset++
        continue
      }

      // Recently updated — assign to key
      availableKey.docIds.push(doc.id)
      recovered++
      console.log(`[KeyPool] Recovery: Key ${availableKey.keyIndex} re-assigned doc ${doc.id.slice(0, 8)}... (${availableKey.docIds.length}/${MAX_DOCS_PER_KEY}, status: ${doc.payload.status})`)

      // Persist key assignment to SQLite
      try {
        await retryDbOp(db => db.jobQueue.upsert({
          where: { id: `key-${availableKey.keyIndex}-doc-${doc.id.slice(0, 8)}` },
          update: { status: 'running', documentId: doc.id, updatedAt: new Date() },
          create: {
            id: `key-${availableKey.keyIndex}-doc-${doc.id.slice(0, 8)}`,
            type: 'key_assignment',
            status: 'running',
            documentId: doc.id,
            priority: availableKey.keyIndex,
          },
        }))
      } catch (e) {
        console.warn(`[KeyPool] Failed to persist key ${availableKey.keyIndex} to SQLite:`, e)
      }
    }

    console.log(`[KeyPool] Recovery complete: ${recovered} key(s) re-assigned, ${staleReset} stale doc(s) reset to 'partial'`)
    return { recovered, keys: getKeyStatus() }
  } catch (err) {
    console.error('[KeyPool] Key recovery failed:', err)
    return { recovered: 0, keys: getKeyStatus() }
  }
}

/** Persist current key assignments to SQLite for crash recovery */
export async function persistKeyAssignments(): Promise<void> {
  try {
    for (const ka of keyAssignments) {
      const status = ka.docIds.length > 0 ? 'running' : 'available'
      const documentId = ka.docIds.length > 0 ? ka.docIds.join(',') : null
      await retryDbOp(db => db.jobQueue.upsert({
        where: { id: `key-${ka.keyIndex}` },
        update: {
          status,
          documentId,
          updatedAt: new Date(),
        },
        create: {
          id: `key-${ka.keyIndex}`,
          type: 'key_assignment',
          status,
          documentId,
          priority: ka.keyIndex,
        },
      }))
    }
  } catch (err) {
    console.warn('[KeyPool] Failed to persist key assignments:', err)
  }
}

// Run recovery on module load (after server restart)
recoverKeys().catch(() => {})


/**
 * Key Assignment Pool — 4 API keys for document processing (AUTO MODE).
 *
 * No more slot mode — documents are automatically assigned to the key
 * with the fewest active documents (least-loaded first).
 *
 * Each key can handle up to 4 documents concurrently.
 * Max concurrent: 4 keys × 4 docs = 16 documents.
 *
 * Key N uses NVIDIA Key N (strict binding for rate limit isolation).
 * If Key N is rate-limited/exhausted, the system falls back to another
 * available key from the same provider.
 */

// ==================== PAUSE MECHANISM ====================

/**
 * In-memory set of document IDs that have been paused by the user.
 * The extraction loop checks this set before each chunk group and
 * the auto-chain loop checks before each batch. When a document is
 * found in this set, the pipeline stops immediately and returns 'partial'.
 *
 * The set is cleared when a document is re-started (handleProcessDoc).
 */
const pausedDocIds: Set<string> = new Set()

/** Mark a document as paused — the pipeline will stop at the next checkpoint */
export function markDocPaused(docId: string): void {
  pausedDocIds.add(docId)
  console.log(`[KeyPool] Document ${docId.slice(0, 8)}... marked as PAUSED`)
}

/** Clear the paused flag when a document is re-started */
export function clearDocPaused(docId: string): void {
  pausedDocIds.delete(docId)
}

/** Check if a document has been paused */
export function isDocPaused(docId: string): boolean {
  return pausedDocIds.has(docId)
}

interface KeyAssignment {
  keyIndex: number
  docIds: string[]             // Documents currently using this key (up to MAX_DOCS_PER_KEY)
  failureCount: number         // Consecutive failures
}

const keyAssignments: KeyAssignment[] = []

/** Initialize key assignments — auto mode, least-loaded-first */
function initKeyAssignments(): void {
  if (keyAssignments.length > 0) return
  for (let i = 0; i < MAX_KEYS; i++) {
    keyAssignments.push({
      keyIndex: i,
      docIds: [],
      failureCount: 0,
    })
  }
  console.log(`[KeyPool] Initialized ${MAX_KEYS} keys × ${MAX_DOCS_PER_KEY} docs/key = ${MAX_TOTAL_CONCURRENT} max concurrent (auto mode, Key N → NVIDIA Key N)`)
}
initKeyAssignments()

/** Acquire a key for a document (auto mode: least-loaded-first).
 *  Returns the key index, or -1 if all keys are at capacity.
 *  Each key can hold up to MAX_DOCS_PER_KEY documents.
 *  Key N uses NVIDIA Key N.
 */
export function acquireKey(docId: string): number {
  initKeyAssignments()
  // First check if this doc already has a key (idempotent)
  for (const ka of keyAssignments) {
    if (ka.docIds.includes(docId)) return ka.keyIndex
  }

  // Global cap: can't exceed MAX_TOTAL_CONCURRENT across all keys
  const totalDocs = keyAssignments.reduce((sum, k) => sum + k.docIds.length, 0)
  if (totalDocs >= MAX_TOTAL_CONCURRENT) return -1

  // Auto mode: find key with fewest docs (least-loaded-first)
  const availableKey = keyAssignments
    .filter(k => k.docIds.length < MAX_DOCS_PER_KEY)
    .sort((a, b) => a.docIds.length - b.docIds.length)[0]
  if (!availableKey) return -1 // All at capacity

  availableKey.docIds.push(docId)
  console.log(`[KeyPool] Key ${availableKey.keyIndex} acquired by doc ${docId.slice(0, 8)}... (${availableKey.docIds.length}/${MAX_DOCS_PER_KEY} docs, uses NVIDIA key ${availableKey.keyIndex + 1})`)
  return availableKey.keyIndex
}

/** Release a key when a document finishes processing */
export function releaseKey(docId: string): void {
  for (const ka of keyAssignments) {
    const idx = ka.docIds.indexOf(docId)
    if (idx >= 0) {
      ka.docIds.splice(idx, 1)
      console.log(`[KeyPool] Key ${ka.keyIndex} released by doc ${docId.slice(0, 8)}... (${ka.docIds.length}/${MAX_DOCS_PER_KEY} docs remaining)`)
      // FIX (unbounded table growth): doc-specific JobQueue rows
      // (`key-N-doc-XXXXXXXX`) were write-only — never deleted when the
      // document finished, so the table grew forever. Delete the row for
      // this doc (fire-and-forget, best effort).
      try {
        db.jobQueue.delete({ where: { id: `key-${ka.keyIndex}-doc-${docId.slice(0, 8)}` } }).catch(() => {})
      } catch { /* ignore — best effort cleanup */ }
      if (ka.docIds.length === 0) {
        ka.failureCount = 0
      }
      return
    }
  }
}

/** Get the current key assignment status (for UI display) */
export function getKeyStatus(): Array<{
  keyIndex: number
  docIds: string[]
}> {
  return keyAssignments.map(k => ({
    keyIndex: k.keyIndex,
    docIds: [...k.docIds],
  }))
}

/** Get number of available capacity across all keys */
export function getFreeKeyCount(): number {
  return keyAssignments.reduce((sum, k) => sum + (MAX_DOCS_PER_KEY - k.docIds.length), 0)
}

/** Get total number of documents currently assigned to keys */
export function getActiveDocCount(): number {
  return keyAssignments.reduce((sum, k) => sum + k.docIds.length, 0)
}

/** Get ALL document IDs currently assigned to a key (actively being processed).
 *  Used by reconciliation to skip docs that have an active key assignment,
 *  preventing the reconciliation from interfering with a running pipeline.
 */
export function getActiveDocIds(): string[] {
  return keyAssignments.flatMap(k => k.docIds)
}

// ==================== DAILY QUOTA CONFIGURATION ====================

/** Provider-specific daily token limits (conservative estimates for free tiers).
 *  These are used for proactive detection — when daily usage approaches these
 *  limits, the key is marked as daily-quota-exhausted BEFORE the API returns 429.
 *
 *  The reactive detection (parsing 429 error bodies) serves as a backup for
 *  cases where the actual limit differs from these estimates.
 *
 *  Set to 0 to disable proactive tracking for a provider (rely on 429 detection only).
 */
const PROVIDER_DAILY_TOKEN_LIMITS: Record<string, number> = {
  // NVIDIA: No documented daily limit (rate-limit only, 40 RPM/key)
  NVIDIA: 0,
}

/** Get the timestamp of the next midnight in the user's timezone (Asia/Ho_Chi_Minh, UTC+7).
 *  Used as the reset time for daily quota exhaustion. */
function getMidnightTimestamp(): number {
  const now = new Date()
  // User timezone: UTC+7 (Asia/Ho_Chi_Minh)
  const utcOffsetMs = 7 * 60 * 60 * 1000
  const localNow = new Date(now.getTime() + utcOffsetMs)
  // Set to midnight local time
  const localMidnight = new Date(localNow)
  localMidnight.setUTCHours(24, 0, 0, 0) // Next midnight
  // Convert back to UTC timestamp
  return localMidnight.getTime() - utcOffsetMs
}

/** Parse a 429 response body to determine if it's a daily quota exhaustion
 *  (permanent until midnight) vs a temporary rate limit (RPM exceeded, retry after cooldown).
 *
 *  Returns { isDailyQuota: boolean, resetAt?: number } based on error body analysis.
 *
 *  Provider-specific patterns:
 *  - NVIDIA: "exceeded" / "limit reached" / "token limit"
 */
function parse429ForDailyQuota(providerName: string, body: string): { isDailyQuota: boolean; resetAt?: number } {
  const lower = body.toLowerCase()

  // Universal patterns that indicate daily quota exhaustion
  const dailyPatterns = [
    'daily',
    'insufficient_quota',
    'plan limit',
    'billing',
    'credits',
    'budget',
    'allocation',
    'monthly',
    'tier limit',
  ]

  // Patterns that indicate TEMPORARY rate limit (should NOT trigger daily quota)
  const temporaryPatterns = [
    'rate limit',
    'too many requests',
    'requests per minute',
    'rpm',
    'rpm limit',
    'concurrent',
    'simultaneous',
    'per second',
    'per minute',
    'request limit exceeded',     // NVIDIA: "Request limit exceeded" = RPM limit, NOT daily quota
    'requests exceeded',          // NVIDIA: "Requests exceeded" = RPM limit
    'limit exceeded',             // NVIDIA: "Limit exceeded" = usually RPM, not daily
    'capacity exceeded',          // NVIDIA: temporary capacity issue
    'server is busy',             // NVIDIA: temporary overload
    'try again',                  // Generic: temporary issue, try later
    'back off',                   // Generic: exponential backoff needed
    'retry after',                // Generic: retry after a delay
    'slow down',                  // Generic: rate limiting
  ]

  // Check for temporary patterns first
  for (const pattern of temporaryPatterns) {
    if (lower.includes(pattern)) {
      return { isDailyQuota: false }
    }
  }

  // Check for daily/quota patterns
  for (const pattern of dailyPatterns) {
    if (lower.includes(pattern)) {
      return { isDailyQuota: true, resetAt: getMidnightTimestamp() }
    }
  }

  // NVIDIA-specific: Only match truly daily/quota-specific patterns.
  // BUG FIX: The old "exceeded" pattern was too broad — it matched "Request limit exceeded"
  // (which is a temporary RPM limit, not daily quota). Now we require "daily" or "quota"
  // context to confirm it's truly a daily quota exhaustion, not just a temporary rate limit.
  if (providerName === 'NVIDIA') {
    // Truly daily quota patterns (NOT just "exceeded" which is usually RPM)
    if (lower.includes('daily quota') || lower.includes('daily limit') ||
        lower.includes('quota exceeded') || lower.includes('daily allocation') ||
        lower.includes('token limit reached for today') || lower.includes('daily token')) {
      return { isDailyQuota: true, resetAt: getMidnightTimestamp() }
    }
    // "limit reached" without "daily" context — could be RPM, treat as temporary
    // Only mark as daily if it explicitly says "daily" or "quota"
    if (lower.includes('limit reached') && (lower.includes('daily') || lower.includes('quota'))) {
      return { isDailyQuota: true, resetAt: getMidnightTimestamp() }
    }
  }

  // Default: not daily quota, treat as temporary rate limit
  return { isDailyQuota: false }
}

// ==================== PROVIDER KEY POOL (NVIDIA NIM ONLY) ====================

interface ProviderKeyInfo {
  key: string
  keyIndex: number  // Index in the pool's keys array — used for per-key token tracking
  rateLimited: boolean
  rateLimitResetAt: number
  failureCount: number
  exhausted: boolean
  exhaustedAt: number
  // Daily quota exhaustion — key hit its daily limit (tokens or requests).
  // Unlike `exhausted` (which recovers after 60s cooldown), daily quota resets at midnight.
  dailyQuotaExhausted: boolean
  dailyQuotaResetAt: number  // Timestamp when daily quota resets (midnight in user timezone)
  // Per-key token tracking
  totalTokensUsed: number
  // Per-key daily token tracking
  dailyTokensUsed: number
  // Per-key daily request tracking
  dailyRequestCount: number
  dailyRequestDate: string  // YYYY-MM-DD in user timezone
}

class ProviderKeyPool {
  private keys: ProviderKeyInfo[]
  private nextKeyIndex: number = 0
  private _providerName: string
  private exhaustionCooldownMs: number

  constructor(providerName: string, keys: string[], exhaustionCooldownMs = 60000) {
    this._providerName = providerName
    this.exhaustionCooldownMs = exhaustionCooldownMs
    // CRITICAL: Do NOT filter out empty strings — that would shift array indices
    // and break the key-to-NVIDIA-key mapping (Key N must use NVIDIA Key N).
    // Instead, keep empty entries as placeholder objects with an empty key.
    // getKeyByIndex() will skip them and fall back to getNextKey().
    this.keys = keys.map((key, idx) => ({
      key,
      keyIndex: idx,  // Track which index this key is at — used for per-key token tracking
      rateLimited: false,
      rateLimitResetAt: 0,
      failureCount: 0,
      exhausted: key === '', // Mark empty keys as exhausted so they're never used
      exhaustedAt: key === '' ? 0 : 0,
      dailyQuotaExhausted: false, // Daily quota not exhausted yet
      dailyQuotaResetAt: 0,        // Will be set when quota is hit
      totalTokensUsed: 0,  // Track cumulative token usage per key
      dailyTokensUsed: 0, // Track daily token usage per key (resets at midnight)
      dailyRequestCount: 0, // Track daily request count per key
      dailyRequestDate: '',  // Will be set on first use
    }))
  }

  /** Provider name (public getter) */
  get providerName(): string { return this._providerName }

  /** Get next available key (round-robin, skipping empty/rate-limited/exhausted) */
  getNextKey(): ProviderKeyInfo | null {
    // Try all keys starting from nextKeyIndex
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.nextKeyIndex + i) % this.keys.length
      const keyInfo = this.keys[idx]

      // Skip empty keys (missing env var) — permanently unavailable
      if (!keyInfo.key) continue

      // Check rate limit reset
      if (keyInfo.rateLimited && Date.now() >= keyInfo.rateLimitResetAt) {
        keyInfo.rateLimited = false
        keyInfo.failureCount = 0
      }

      // Check exhaustion recovery (but not for empty keys — they stay exhausted forever)
      if (keyInfo.exhausted && keyInfo.key && Date.now() >= keyInfo.exhaustedAt + this.exhaustionCooldownMs) {
        keyInfo.exhausted = false
        keyInfo.exhaustedAt = 0
        keyInfo.failureCount = 0
      }

      // Check daily quota exhaustion — skip key if daily limit reached and not yet reset
      if (keyInfo.dailyQuotaExhausted) {
        if (Date.now() >= keyInfo.dailyQuotaResetAt) {
          // Past reset time — clear daily quota exhaustion
          keyInfo.dailyQuotaExhausted = false
          keyInfo.dailyQuotaResetAt = 0
          keyInfo.dailyTokensUsed = 0
          keyInfo.dailyRequestCount = 0
          keyInfo.dailyRequestDate = getTodayDateStr()
          console.log(`[LLM] ${this._providerName} key#${idx} ...${keyInfo.key.slice(-6)} daily quota reset (time expired) ✓`)
        } else {
          continue // Skip this key — daily quota still exhausted
        }
      }

      if (!keyInfo.rateLimited && !keyInfo.exhausted) {
        this.nextKeyIndex = (idx + 1) % this.keys.length
        return keyInfo
      }
    }
    // Emergency fallback: if ALL keys are daily-quota-exhausted, force-reset one
    return this.emergencyDailyQuotaReset()  // Returns null if emergency not applicable
  }

  /** Emergency recovery: If ALL keys are daily-quota-exhausted, reset the one
   *  that was exhausted earliest (15-minute minimum wait). This prevents a
   *  total system freeze where no extraction is possible until midnight.
   *  The 15-minute wait ensures we don't immediately re-trigger the quota. */
  private emergencyDailyQuotaReset(): ProviderKeyInfo | null {
    const DAILY_QUOTA_EMERGENCY_RESET_MS = 15 * 60 * 1000 // 15 minutes minimum wait
    const allValidKeys = this.keys.filter(k => !!k.key)
    const dailyExhaustedKeys = allValidKeys.filter(k => k.dailyQuotaExhausted)

    // Only trigger emergency if ALL valid keys are daily-quota-exhausted
    if (dailyExhaustedKeys.length > 0 && dailyExhaustedKeys.length === allValidKeys.length) {
      // Sort by dailyQuotaResetAt ascending — the one with earliest reset was marked first
      const earliest = dailyExhaustedKeys.sort((a, b) => a.dailyQuotaResetAt - b.dailyQuotaResetAt)[0]
      // Calculate when this key was marked: resetAt is midnight, so markedAt = some time before that
      // We can't know exact markedAt, but we know midnight - markedAt >= 15min means it's been a while
      // Simpler: always allow emergency reset if we're here (all keys stuck), just add a rate limit
      const idx = this.keys.indexOf(earliest)
      console.warn(`[LLM] EMERGENCY: All ${dailyExhaustedKeys.length} ${this._providerName} keys are daily-quota-exhausted. Force-resetting key#${idx} ...${earliest.key.slice(-6)}`)
      earliest.dailyQuotaExhausted = false
      earliest.dailyQuotaResetAt = 0
      earliest.failureCount = 0
      earliest.rateLimited = false
      this.nextKeyIndex = (idx + 1) % this.keys.length
      return earliest
    }
    return null
  }

  /** Get key at a specific index (for KEY-BASED key selection with fallback).
   *
   *  Priority:
   *   1. Try the exact key for this index (Key N → NVIDIA Key N, strict binding)
   *   2. If that key is unavailable (rate-limited/exhausted), fall back to getNextKey()
   *      which uses a round-robin key from the SAME provider (cross-key sharing).
   *
   *  This "strict-first, fallback-second" approach ensures:
   *   - Under normal load: each key assignment uses its own dedicated key (max parallelism)
   *   - Under heavy load: keys share capacity rather than failing entirely
   *   - No key is ever completely stuck if the provider has ANY available key
   */
  getKeyByIndex(index: number): ProviderKeyInfo | null {
    if (index < 0 || index >= this.keys.length) return null
    const keyInfo = this.keys[index]
    // Empty key (missing env var) — permanently unavailable, never recover
    if (!keyInfo.key) return this.getNextKey() // Fallback to another available key
    // Check rate limit reset
    if (keyInfo.rateLimited && Date.now() >= keyInfo.rateLimitResetAt) {
      keyInfo.rateLimited = false
      keyInfo.failureCount = 0
    }
    // Check exhaustion recovery
    if (keyInfo.exhausted && Date.now() >= keyInfo.exhaustedAt + this.exhaustionCooldownMs) {
      keyInfo.exhausted = false
      keyInfo.exhaustedAt = 0
      keyInfo.failureCount = 0
    }

    // Check daily quota exhaustion — skip key if daily limit reached
    if (keyInfo.dailyQuotaExhausted) {
      if (Date.now() >= keyInfo.dailyQuotaResetAt) {
        keyInfo.dailyQuotaExhausted = false
        keyInfo.dailyQuotaResetAt = 0
        keyInfo.dailyTokensUsed = 0
        keyInfo.dailyRequestCount = 0
        keyInfo.dailyRequestDate = getTodayDateStr()
      } else {
        // Daily quota still exhausted — fall through to fallback
      }
    }
    if (!keyInfo.rateLimited && !keyInfo.exhausted && !keyInfo.dailyQuotaExhausted) return keyInfo
    // KEY UNAVAILABLE — fall back to another available key from this provider
    // This prevents a key from being completely stuck when its dedicated key is rate-limited.
    // We still prefer the dedicated key (tried first above), but sharing is better than failing.
    console.log(`[LLM] ${this._providerName} key#${index} unavailable, trying fallback key`)
    return this.getNextKey()
  }

  /** Mark a key as rate-limited.
   *  Exhaustion threshold is 20 — high enough to avoid premature exhaustion
   *  from temporary rate limits (40 RPM/key), but low enough to stop using
   *  truly broken keys. Each 429 or error increments failureCount;
   *  markSuccess resets it to 0. */
  markRateLimited(key: string, cooldownMs: number): void {
    const keyInfo = this.keys.find(k => k.key === key)
    if (keyInfo) {
      keyInfo.rateLimited = true
      keyInfo.rateLimitResetAt = Date.now() + cooldownMs
      keyInfo.failureCount++
      if (keyInfo.failureCount >= 20) {
        keyInfo.exhausted = true
        keyInfo.exhaustedAt = Date.now()
        console.log(`[LLM] ${this._providerName} key#${this.keys.indexOf(keyInfo)} ...${key.slice(-6)} marked exhausted (auto-retry in ${this.exhaustionCooldownMs / 1000}s)`)
      }
    }
  }

  /** Mark a key as rate-limited WITHOUT incrementing failureCount.
   *  Used for fallback attempts — the original key already absorbed the failure,
   *  so fallback keys should NOT be penalized with failureCount increments.
   *  Without this, fallback cascades can exhaust ALL keys in seconds. */
  markRateLimitedSoft(key: string, cooldownMs: number): void {
    const keyInfo = this.keys.find(k => k.key === key)
    if (keyInfo) {
      keyInfo.rateLimited = true
      keyInfo.rateLimitResetAt = Date.now() + cooldownMs
      // NO failureCount++ — this was a fallback attempt, not a primary failure
    }
  }

  /** Mark a key as daily-quota-exhausted.
   *  Unlike `exhausted` (which recovers after cooldownMs), daily quota resets at midnight.
   *  This is triggered when the API returns a 429 with a message indicating daily limit,
   *  or when our proactive tracking detects the limit has been reached.
   *
   *  @param resetAt - Timestamp when the daily quota resets (default: midnight in user timezone) */
  markDailyQuotaExhausted(key: string, resetAt?: number): void {
    const keyInfo = this.keys.find(k => k.key === key)
    if (keyInfo) {
      keyInfo.dailyQuotaExhausted = true
      keyInfo.dailyQuotaResetAt = resetAt || getMidnightTimestamp()
      const idx = this.keys.indexOf(keyInfo)
      console.warn(`[LLM] ${this._providerName} key#${idx} ...${key.slice(-6)} DAILY QUOTA EXHAUSTED — disabled until ${new Date(keyInfo.dailyQuotaResetAt).toLocaleString()}`)
    }
  }

  /** Mark a key as successful (reset failure count, clear exhaustion).
   *  Also tracks per-key token usage, daily token tracking, and request counts. */
  markSuccess(key: string, tokensUsed?: number): void {
    const keyInfo = this.keys.find(k => k.key === key)
    if (keyInfo) {
      keyInfo.failureCount = 0
      // Clear exhaustion if present (successful call proves the key works)
      if (keyInfo.exhausted) {
        keyInfo.exhausted = false
        keyInfo.exhaustedAt = 0
        console.log(`[LLM] ${this._providerName} key#${this.keys.indexOf(keyInfo)} ...${key.slice(-6)} recovered from exhaustion ✓`)
      }
      // Track per-key token usage
      if (tokensUsed && tokensUsed > 0) {
        keyInfo.totalTokensUsed += tokensUsed
      }
      // Track per-key daily token and request counts
      const today = getTodayDateStr()
      if (keyInfo.dailyRequestDate !== today) {
        // New day — reset daily counters
        keyInfo.dailyRequestCount = 1
        keyInfo.dailyRequestDate = today
        keyInfo.dailyTokensUsed = tokensUsed || 0
        // Also clear daily quota exhaustion on new day
        if (keyInfo.dailyQuotaExhausted && Date.now() >= keyInfo.dailyQuotaResetAt) {
          keyInfo.dailyQuotaExhausted = false
          keyInfo.dailyQuotaResetAt = 0
          console.log(`[LLM] ${this._providerName} key#${this.keys.indexOf(keyInfo)} ...${key.slice(-6)} daily quota reset (new day) ✓`)
        }
      } else {
        keyInfo.dailyRequestCount++
        keyInfo.dailyTokensUsed += (tokensUsed || 0)
      }
    }
  }

  /** Check if any key is available (considering per-provider limits and daily quota) */
  hasAvailableKey(): boolean {
    return this.keys.some(k => {
      if (!k.key) return false // Empty key (missing env var)
      if (k.rateLimited && Date.now() < k.rateLimitResetAt) return false
      if (k.exhausted && Date.now() < k.exhaustedAt + this.exhaustionCooldownMs) return false
      if (k.dailyQuotaExhausted && Date.now() < k.dailyQuotaResetAt) return false
      // Auto-reset daily quota if past reset time
      if (k.dailyQuotaExhausted && Date.now() >= k.dailyQuotaResetAt) {
        k.dailyQuotaExhausted = false
        k.dailyQuotaResetAt = 0
      }
      return true
    })
  }

  get keyCount(): number { return this.keys.filter(k => !!k.key).length }
  get availableCount(): number { return this.keys.filter(k => !!k.key && !k.rateLimited && !k.exhausted && !k.dailyQuotaExhausted).length }

  /** Get count of keys with daily quota exhausted */
  get dailyQuotaExhaustedCount(): number { return this.keys.filter(k => !!k.key && k.dailyQuotaExhausted && Date.now() < k.dailyQuotaResetAt).length }

  /** Get provider availability as a ratio (0.0 to 1.0).
   *  Used for backpressure decisions — when availability is low,
   *  workers should pause to prevent cascading exhaustion. */
  getAvailability(): number {
    const available = this.keys.filter(k => {
      if (!k.key) return false // Empty key (missing env var)
      // Rate-limited and cooldown not yet expired
      if (k.rateLimited && Date.now() < k.rateLimitResetAt) return false
      // Exhausted and cooldown not yet expired
      if (k.exhausted && Date.now() < k.exhaustedAt + this.exhaustionCooldownMs) return false
      // Daily quota exhausted and not yet reset
      if (k.dailyQuotaExhausted && Date.now() < k.dailyQuotaResetAt) return false
      // Auto-reset daily quota if past reset time
      if (k.dailyQuotaExhausted && Date.now() >= k.dailyQuotaResetAt) {
        k.dailyQuotaExhausted = false
        k.dailyQuotaResetAt = 0
      }
      return true
    }).length
    return this.keys.length > 0 ? available / this.keys.length : 0
  }

  /** Get detailed key status for diagnostics (includes token/request/daily-quota tracking) */
  getKeyStatus(): Array<{
    index: number
    available: boolean
    rateLimited: boolean
    exhausted: boolean
    dailyQuotaExhausted: boolean
    dailyQuotaResetAt: number
    failureCount: number
    totalTokensUsed: number
    dailyTokensUsed: number
    dailyRequestCount: number
    dailyRequestDate: string
  }> {
    return this.keys.map((k, i) => ({
      index: i,
      available: !!k.key && !k.rateLimited && !k.exhausted && !k.dailyQuotaExhausted,
      rateLimited: k.rateLimited && Date.now() < k.rateLimitResetAt,
      exhausted: k.exhausted,
      dailyQuotaExhausted: k.dailyQuotaExhausted && Date.now() < k.dailyQuotaResetAt,
      dailyQuotaResetAt: k.dailyQuotaResetAt,
      failureCount: k.failureCount,
      totalTokensUsed: k.totalTokensUsed,
      dailyTokensUsed: k.dailyTokensUsed,
      dailyRequestCount: k.dailyRequestCount,
      dailyRequestDate: k.dailyRequestDate,
    }))
  }

  /** Get total tokens used across all keys (for diagnostics) */
  get totalTokensUsed(): number {
    return this.keys.reduce((sum, k) => sum + k.totalTokensUsed, 0)
  }

  /** Get total daily tokens used across all keys (for diagnostics) */
  get totalDailyTokensUsed(): number {
    const today = getTodayDateStr()
    return this.keys.reduce((sum, k) => sum + (k.dailyRequestDate === today ? k.dailyTokensUsed : 0), 0)
  }

  /** Get total daily requests across all keys (for diagnostics) */
  get totalDailyRequests(): number {
    const today = getTodayDateStr()
    return this.keys.reduce((sum, k) => sum + (k.dailyRequestDate === today ? k.dailyRequestCount : 0), 0)
  }
}

// ==================== INITIALIZE PROVIDER POOLS ====================
// Only NVIDIA NIM is active.

const nvidiaPool = new ProviderKeyPool('NVIDIA', [
  process.env.NVIDIA_API_KEY_1 || '',
  process.env.NVIDIA_API_KEY_2 || '',
  process.env.NVIDIA_API_KEY_3 || '',
  process.env.NVIDIA_API_KEY_4 || '',
])

console.log(`[LLM] Provider pool: NVIDIA=${nvidiaPool.keyCount} keys (${NVIDIA_MODELS.length} models) — SINGLE PROVIDER`)
console.log(`[LLM] NVIDIA: 2 extraction cores + 4 agent/chat cores = 6 models, 4 keys × 4 docs = 16 max concurrent`)

// ==================== BACKPRESSURE — PROVIDER AVAILABILITY ====================

/** Get overall provider availability across all active pools (0.0 to 1.0).
 *  Used by the extraction pipeline to implement backpressure:
 *  - availability < 0.25 → pause chunk dispatch for 10s (cascading exhaustion protection)
 *  - availability >= 0.5 → normal operation
 *
 *  This prevents the scenario where 8 concurrent workers keep pulling chunks
 *  even when ALL providers are failing, which accelerates key exhaustion.
 */
export function getOverallAvailability(): number {
  // Only NVIDIA pool matters
  return nvidiaPool.keyCount > 0 ? nvidiaPool.getAvailability() : 0
}

/** Get per-provider availability for adaptive concurrency decisions.
 *  Returns a record like { nvidia: 0.75 } */
export function getProviderAvailability(): Record<string, number> {
  return {
    nvidia: nvidiaPool.getAvailability(),
  }
}

// ==================== KEY-BASED PROVIDER TRY FUNCTION ====================

/**
 * Provider call using a ProviderKeyPool with dual key selection mode.
 *
 * Key selection:
 *   - keyIndex >= 0 (0-3): STRICT key binding — uses Key N from each provider
 *   - keyIndex = -1: LEGACY round-robin — uses getNextKey() for non-extraction callers (chat, health)
 *
 * STRICT key binding (keyIndex >= 0):
 * - Key N uses ONLY Key N from each provider (fallback to other keys if unavailable)
 * - If the key is rate-limited or exhausted → return null (skip to next provider)
 * - This ensures each provider's keys are used in parallel across all 4 keys
 *
 * Legacy round-robin (keyIndex = -1):
 * - Uses getNextKey() which cycles through available keys
 * - Used by callLLM() for chat, health checks, classification etc.
 */
async function tryProviderWithSlotKey(
  slotIndex: number,        // 0-3, determines which key to use
  pool: ProviderKeyPool,    // The provider's key pool
  endpoint: string,
  models: string[],
  prompt: string,
  systemPrompt: string | undefined,
  timeoutMs: number = parseInt(process.env.LLM_TIMEOUT_MS || '240000', 10),
  extraHeaders: Record<string, string> = {},
  rateLimitCooldownMs: number = 60000,
  temperature: number = 0.1,
  maxTokens: number = 4096,
  agentId?: string,         // For per-agent token tracking
  agentName?: string,       // For per-agent token tracking
  isFallback: boolean = false, // When true, don't increment failureCount on errors — prevents cascade exhaustion
  // Phase 1c: native function calling params
  tools?: LLMTool[],
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } },
): Promise<LLMResult | null> {
  const providerName = pool.providerName

  // Key selection: key-based (strict) or round-robin (legacy)
  // keyIndex 0-3: STRICT binding — only use Key N from each provider (no cross-key fallback)
  // keyIndex -1: LEGACY round-robin — use getNextKey() for non-extraction tasks (chat, health, classification)
  const keyInfo = slotIndex >= 0
    ? pool.getKeyByIndex(slotIndex)   // Key-based: strict key binding
    : pool.getNextKey()               // Legacy: round-robin key rotation

  if (!keyInfo) {
    if (slotIndex >= 0) {
      console.log(`[LLM] Key ${slotIndex} ${providerName} key#${slotIndex} unavailable (rate-limited/exhausted/limit-reached), skipping to next provider`)
    } else {
      console.log(`[LLM] ${providerName} no available keys (all rate-limited/exhausted/limit-reached), skipping to next provider`)
    }
    return null
  }

  const messages = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    { role: 'user' as const, content: prompt },
  ]

  // MODEL ROTATION: Rotate starting model each call so all models get usage
  const rotatedModels = getRotatedModels(providerName, models)

  // Track consecutive 429s across models — if 2+ models return 429 with the same key,
  // it's likely a key-level rate limit (not model-scoped), so we skip remaining models
  // to prevent unnecessary failureCount increments that accelerate key exhaustion.
  let consecutive429Count = 0

  // Try each model with this slot's dedicated key (rotated order)
  for (const model of rotatedModels) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      // Phase 1c: build request body conditionally — only include `tools`/`tool_choice`
      // when caller provided them. This preserves backward compat for non-FC callers
      // (chat, health, classification, extraction). NIM endpoint accepts OpenAI-style
      // tools param — verified for kimi-k3, glm-5.2, deepseek-v4-flash, minimax-m3.
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: maxTokens ?? 4096,
        temperature: temperature ?? 0.1,
      }
      if (tools && tools.length > 0) {
        body.tools = tools
        body.tool_choice = tool_choice ?? 'auto'
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keyInfo.key}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (response.status === 429) {
        const keyLabel = slotIndex >= 0 ? `key#${slotIndex}` : 'key (round-robin)'
        // Read the response body to distinguish daily quota exhaustion from temporary rate limit
        let errorBody = ''
        try { errorBody = await response.text() } catch { /* ignore read error */ }
        const quotaCheck = parse429ForDailyQuota(providerName, errorBody)

        if (quotaCheck.isDailyQuota) {
          // DAILY QUOTA EXHAUSTED — mark key as daily-exhausted (no retry until midnight)
          console.warn(`[LLM] Key ${slotIndex} ${providerName} ${keyLabel} model ${model} → 429 DAILY QUOTA EXHAUSTED (body: ${errorBody.slice(0, 200)})`)
          pool.markDailyQuotaExhausted(keyInfo.key, quotaCheck.resetAt)
          // Skip remaining models — if one model says daily quota, all will say the same
          break
        }

        // Temporary rate limit (RPM exceeded) — apply cooldown and try next model
        console.log(`[LLM] Key ${slotIndex} ${providerName} ${keyLabel} model ${model} → 429 Rate Limited (cooldown ${rateLimitCooldownMs / 1000}s, fallback=${isFallback}, body: ${errorBody.slice(0, 100)})`)
        // BUG FIX: Use markRateLimitedSoft for fallback attempts to prevent cascade exhaustion.
        // Without this, 8 workers × 4 fallback keys = 32 failureCount increments in seconds,
        // exhausting ALL keys simultaneously.
        if (isFallback) {
          pool.markRateLimitedSoft(keyInfo.key, rateLimitCooldownMs)
        } else {
          pool.markRateLimited(keyInfo.key, rateLimitCooldownMs)
        }
        consecutive429Count++
        // If 2+ consecutive 429s on the same key → likely key-level rate limit,
        // not model-scoped. Skip remaining models to avoid unnecessary failureCount increments.
        if (consecutive429Count >= 2) {
          console.warn(`[LLM] ${consecutive429Count} consecutive 429s on ${providerName} key — assuming key-level rate limit, skipping remaining models`)
          break  // Exit model loop → move to next provider
        }
        continue
      }

      // Reset consecutive counter on non-429 response
      consecutive429Count = 0

      if (response.ok) {
        const data = await response.json() as {
          choices: Array<{
            message: {
              content: string
              tool_calls?: Array<{
                id: string
                type: 'function'
                function: { name: string; arguments: string }
              }>
            }
            finish_reason?: string | null
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        }
        const choice = data.choices?.[0]
        const content = choice?.message?.content
        const nativeToolCalls = choice?.message?.tool_calls
        const finishReason = choice?.finish_reason ?? null
        const totalTokens = data.usage?.total_tokens ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0))
        if (content || (nativeToolCalls && nativeToolCalls.length > 0)) {
          const keyLabel = slotIndex >= 0 ? `key#${slotIndex}` : 'key (rr)'
          const tcCount = nativeToolCalls?.length ?? 0
          console.log(`[LLM] Key ${slotIndex} ${providerName} ${keyLabel} model ${model} ✓ (${totalTokens} tokens, ${tcCount} tool_calls, finish=${finishReason || 'none'})`)
          // Pass tokensUsed to markSuccess so per-key token tracking works
          pool.markSuccess(keyInfo.key, totalTokens)
          // Use the ACTUAL key index for per-slot token tracking, not the requested slotIndex.
          // When slotIndex=-1 (round-robin, used by agent/chat calls), we still want to
          // track which key was actually used so the Provider × Slot table shows all tokens.
          // When getKeyByIndex() falls back to a different key, we also want the correct slot.
          const actualKeyIndex = keyInfo.keyIndex
          if (totalTokens > 0) addTokensUsed(totalTokens, providerName.toLowerCase(), actualKeyIndex, model)
          // Per-agent token tracking
          if (totalTokens > 0 && agentId && agentName) {
            const inputTokens = data.usage?.prompt_tokens ?? 0
            const outputTokens = data.usage?.completion_tokens ?? 0
            addTokensUsedByAgent(totalTokens, inputTokens, outputTokens, providerName.toLowerCase(), model, agentId, agentName)
          }
          return {
            content: content ?? '',  // NIM may return empty content when finish_reason='tool_calls'
            provider: providerName.toLowerCase(),
            model,
            tokensUsed: totalTokens,
            tool_calls: nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
            finish_reason: finishReason,
          }
        }
      }

      // Non-429 HTTP error (5xx, 401, 403, etc.) — mark as rate-limited with short cooldown
      // so failureCount increments but the key can recover quickly.
      // This prevents silent failures from flying under the radar.
      const isServerError = response.status >= 500
      const isAuthError = response.status === 401 || response.status === 403
      if (isServerError || isAuthError) {
        const cooldown = isServerError ? 10000 : 60000 // 10s for 5xx, 60s for auth errors
        console.warn(`[LLM] Key ${slotIndex} ${providerName} key#${slotIndex} model ${model} HTTP ${response.status} — marking rate-limited (${cooldown / 1000}s cooldown, fallback=${isFallback})`)
        if (isFallback) {
          pool.markRateLimitedSoft(keyInfo.key, cooldown)
        } else {
          pool.markRateLimited(keyInfo.key, cooldown)
        }
        if (isAuthError) break // Auth error won't be fixed by trying other models
      } else {
        console.log(`[LLM] Key ${slotIndex} ${providerName} key#${slotIndex} model ${model} HTTP ${response.status}`)
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.log(`[LLM] Key ${slotIndex} ${providerName} key#${slotIndex} model ${model} timed out (${timeoutMs / 1000}s)`)
      } else {
        console.log(`[LLM] Key ${slotIndex} ${providerName} key#${slotIndex} model ${model} error: ${err instanceof Error ? err.message : 'unknown'}`)
      }
      // Network errors — use soft marking for fallback to prevent cascade exhaustion
      if (isFallback) {
        pool.markRateLimitedSoft(keyInfo.key, 10000) // 10s cooldown, no failureCount increment
      } else {
        pool.markRateLimited(keyInfo.key, 10000) // 10s cooldown for network errors
      }
    }
  }

  // All models failed for this provider's key — return null so caller tries next provider
  return null
}

// ==================== PROVIDER-SPECIFIC TRY FUNCTIONS ====================

/** Try NVIDIA NIM with assigned key — EXTRACTION ONLY: chỉ 2 lõi llama-3.3-70b, gpt-oss-120b */
async function tryNvidiaSlot(slotIndex: number, prompt: string, systemPrompt: string | undefined, temperature?: number, maxTokens?: number, agentId?: string, agentName?: string, isFallback: boolean = false): Promise<LLMResult | null> {
  return tryProviderWithSlotKey(
    slotIndex,
    nvidiaPool,
    'https://integrate.api.nvidia.com/v1/chat/completions',
    NVIDIA_EXTRACTION_MODELS,
    prompt,
    systemPrompt,
    120000, // 120s timeout (increased from 60s — user Option C: nemotron-550b is ~9s/call, allow longer)
    {},
    30000, // 30s rate limit cooldown — shorter to recover faster from temporary rate limits
    temperature ?? 0.1,
    maxTokens ?? 4096,
    agentId,
    agentName,
    isFallback,
    // Phase 1c: extraction path does not use native FC — left undefined intentionally
  )
}

// ==================== LEGACY PROVIDER TRY FUNCTIONS (for callLLM) ====================

/** Try NVIDIA NIM — 4 keys × 4 docs, no daily cap (legacy round-robin)
 *  MODEL POLICY 2026-08-25: chat/agent path dùng NVIDIA_AGENT_MODELS —
 *  kimi-k3 mặc định, các lõi khác failover backup (không rotation). */
async function tryNvidia(prompt: string, systemPrompt: string | undefined, temperature?: number, maxTokens?: number, agentId?: string, agentName?: string): Promise<LLMResult | null> {
  return tryProviderWithSlotKey(
    -1,
    nvidiaPool,
    'https://integrate.api.nvidia.com/v1/chat/completions',
    NVIDIA_AGENT_MODELS,
    prompt,
    systemPrompt,
    60000,
    {},
    30000, // 30s rate limit cooldown (same as extraction)
    temperature ?? 0.1,
    maxTokens ?? 4096,
    agentId,
    agentName,
  )
}

/** Get per-provider key pool diagnostics (token usage, request counts, key status) */
export function getProviderDiagnostics(): Record<string, {
  keyCount: number
  availableCount: number
  dailyQuotaExhaustedCount: number
  totalTokensUsed: number
  totalDailyTokensUsed: number
  totalDailyRequests: number
  dailyTokenLimit: number
  keys: Array<{
    index: number
    available: boolean
    rateLimited: boolean
    exhausted: boolean
    dailyQuotaExhausted: boolean
    dailyQuotaResetAt: number
    failureCount: number
    totalTokensUsed: number
    dailyTokensUsed: number
    dailyRequestCount: number
    dailyRequestDate: string
  }>
}> {
  const pools = [
    { name: 'NVIDIA', pool: nvidiaPool },
  ]
  const result: Record<string, {
    keyCount: number
    availableCount: number
    dailyQuotaExhaustedCount: number
    totalTokensUsed: number
    totalDailyTokensUsed: number
    totalDailyRequests: number
    dailyTokenLimit: number
    keys: Array<{
      index: number
      available: boolean
      rateLimited: boolean
      exhausted: boolean
      dailyQuotaExhausted: boolean
      dailyQuotaResetAt: number
      failureCount: number
      totalTokensUsed: number
      dailyTokensUsed: number
      dailyRequestCount: number
      dailyRequestDate: string
    }>
  }> = {}
  for (const { name, pool } of pools) {
    result[name] = {
      keyCount: pool.keyCount,
      availableCount: pool.availableCount,
      dailyQuotaExhaustedCount: pool.dailyQuotaExhaustedCount,
      totalTokensUsed: pool.totalTokensUsed,
      totalDailyTokensUsed: pool.totalDailyTokensUsed,
      totalDailyRequests: pool.totalDailyRequests,
      dailyTokenLimit: PROVIDER_DAILY_TOKEN_LIMITS[name] || 0,
      keys: pool.getKeyStatus(),
    }
  }
  return result as Record<string, {
    keyCount: number
    availableCount: number
    dailyQuotaExhaustedCount: number
    totalTokensUsed: number
    totalDailyTokensUsed: number
    totalDailyRequests: number
    dailyTokenLimit: number
    keys: Array<{
      index: number
      available: boolean
      rateLimited: boolean
      exhausted: boolean
      dailyQuotaExhausted: boolean
      dailyQuotaResetAt: number
      failureCount: number
      totalTokensUsed: number
      dailyTokensUsed: number
      dailyRequestCount: number
      dailyRequestDate: string
    }>
  }>
}

// ==================== KEY-BASED CALL (for extraction) ====================

/**
 * Key-based LLM call for document processing — NVIDIA NIM ONLY.
 *
 * Single provider: NVIDIA NIM with 2 extraction cores.
 * Falls back to round-robin key selection if the assigned key is unavailable.
 *
 * @param slotIndex - The key index (0-3) assigned to this document
 * @param prompt - The user prompt
 * @param systemPrompt - Optional system prompt
 * @param task - Task identifier for logging
 */
export async function callLLMSlot(
  slotIndex: number,
  prompt: string,
  systemPrompt?: string,
  task?: string,
  options?: LLMCallOptions
): Promise<LLMResult> {
  const taskLabel = task || 'general'

  // Guard against invalid slot index
  if (slotIndex < 0 || slotIndex >= MAX_KEYS) {
    console.error(`[LLM] Invalid key index ${slotIndex} for task "${taskLabel}" — must be 0-${MAX_KEYS - 1}`)
    return {
      content: '',
      provider: 'none',
      model: 'none',
      error: `Invalid key index ${slotIndex}, must be 0-${MAX_KEYS - 1}`,
    }
  }

  const temp = options?.temperature
  const maxTok = options?.maxTokens
  const aId = options?.agentId
  const aName = options?.agentName

  console.log(`[LLM] Key ${slotIndex} (NVIDIA) Task: ${taskLabel}, Prompt: ${prompt.slice(0, 80)}...`)

  // Try NVIDIA with assigned key (extraction models only)
  const result = await tryNvidiaSlot(slotIndex, prompt, systemPrompt, temp, maxTok, aId, aName)
  if (result?.content) {
    return result
  }

  // Assigned key failed — try other available keys as fallback (cross-key retry)
  // This prevents a document from completely failing just because its assigned
  // key is temporarily rate-limited. Other keys may still have capacity.
  // BUG FIX: Pass isFallback=true so fallback keys don't get failureCount increments
  // that could cascade-exhaust all keys simultaneously.
  console.log(`[LLM] Key ${slotIndex} NVIDIA failed for "${taskLabel}", trying fallback keys...`)
  for (let fallbackIdx = 0; fallbackIdx < MAX_KEYS; fallbackIdx++) {
    if (fallbackIdx === slotIndex) continue // Already tried this key
    const fallbackResult = await tryNvidiaSlot(fallbackIdx, prompt, systemPrompt, temp, maxTok, aId, aName, true)
    if (fallbackResult?.content) {
      console.log(`[LLM] Fallback key ${fallbackIdx} succeeded for "${taskLabel}" (original key ${slotIndex} failed)`)
      return fallbackResult
    }
  }

  // All keys failed
  console.warn(`[LLM] All NVIDIA keys failed for "${taskLabel}" — document will be retried later`)
  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: `NVIDIA NIM failed for all keys (original key ${slotIndex})`,
  }
}

// ==================== LEGACY CALL (for chat, health, etc.) ====================

/**
 * Legacy LLM call — NVIDIA NIM ONLY.
 * Uses round-robin key selection (keyIndex=-1).
 * Use this for non-extraction tasks (chat queries, classification, health checks).
 */
export async function callLLM(
  prompt: string,
  systemPrompt?: string,
  task?: string,
  options?: LLMCallOptions
): Promise<LLMResult> {
  const taskLabel = task || 'general'
  const temp = options?.temperature
  const maxTok = options?.maxTokens
  const aId = options?.agentId
  const aName = options?.agentName
  console.log(`[LLM] (NVIDIA) Task: ${taskLabel}, Prompt: ${prompt.slice(0, 80)}...`)

  // Phase 4 SMOLAB Prop 11' — explicit model override: try ONLY the requested
  // model (all 4 keys, round-robin). Used by the eval harness (judges must not
  // silently fall back to a rotated model — that would reintroduce circular bias
  // between the answer generator and the judges). No pool-rotation fallback.
  if (options?.model) {
    const specific = await callLLMWithSpecificProvider(prompt, 'nvidia', options.model, systemPrompt, options)
    if (specific) return specific
    console.log(`[LLM] Model override "${options.model}" failed for task "${taskLabel}" — returning error (no rotation fallback)`)
    return {
      content: '',
      provider: 'none',
      model: options.model,
      error: `NVIDIA NIM model "${options.model}" failed`,
    }
  }

  // Try NVIDIA only (single provider)
  const result = await tryNvidia(prompt, systemPrompt, temp, maxTok, aId, aName)
  if (result?.content) return result

  console.log(`[LLM] NVIDIA failed for task "${taskLabel}"`)

  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: 'NVIDIA NIM failed',
  }
}

// ==================== AGENT-SPECIFIC CALL (Phase 3) ====================

/** Provider configuration map — used by callLLMWithSpecificProvider()
 *  Maps lowercase provider name to its pool, endpoint, timeout, headers, and rate limit cooldown.
 *  This avoids duplicating these values in multiple places. */
const PROVIDER_CONFIG_MAP: Record<string, {
  pool: ProviderKeyPool
  endpoint: string
  timeout: number
  extraHeaders: Record<string, string>
  rateLimitCooldown: number
}> = {
  nvidia: {
    pool: nvidiaPool,
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    // Audit fix 2026-08-25: kimi-k3 (reasoning model) + large Code Team system
    // prompts can exceed 120s in the reasoning phase → APEX TL timed out every
    // run and degraded the whole workflow to the G1 fallback. Make the timeout
    // env-configurable with a longer 240s default for reasoning models.
    timeout: parseInt(process.env.LLM_TIMEOUT_MS || '240000', 10),
    extraHeaders: {},
    rateLimitCooldown: 45000,
  },
}

/**
 * Call a specific provider with a specific model.
 * Uses round-robin key selection (keyIndex=-1) and tries ALL available keys
 * for that provider before giving up.
 *
 * If the specific model fails, it does NOT fall back to other models in the
 * provider's list — only the agent's configured model is tried.
 *
 * @returns LLMResult if successful, null if the provider/model fails
 */
async function callLLMWithSpecificProvider(
  prompt: string,
  provider: string,
  model: string,
  systemPrompt?: string,
  options?: LLMCallOptions
): Promise<LLMResult | null> {
  const normalizedProvider = provider.toLowerCase()
  const config = PROVIDER_CONFIG_MAP[normalizedProvider]

  if (!config) {
    console.warn(`[LLM] Unknown provider "${provider}" for agent-specific call`)
    return null
  }

  // Try each available key for this provider (round-robin)
  // We only try the specific model, not the full model list
  const result = await tryProviderWithSlotKey(
    -1, // round-robin key selection (non-extraction task)
    config.pool,
    config.endpoint,
    [model], // Only the agent's specific model — no rotation
    prompt,
    systemPrompt,
    config.timeout,
    config.extraHeaders,
    config.rateLimitCooldown,
    options?.temperature ?? 0.1,
    options?.maxTokens ?? 4096,
    options?.agentId,
    options?.agentName,
    false, // not fallback
    // Phase 1c: forward native FC params from options
    options?.tools,
    options?.tool_choice,
  )

  return result
}

/**
 * Call LLM using Agent's configured provider/model first,
 * then fallback to global pool if agent's provider fails.
 *
 * Phase 3: Agent sử dụng Provider/Model riêng khi truy vấn
 *
 * Flow:
 *   1. Try agent's configured provider+model (e.g., NVIDIA/deepseek-v4-pro)
 *   2. If that fails → fallback to global weighted round-robin pool
 *
 * This ensures:
 *   - Agent configured with NVIDIA actually uses NVIDIA
 *   - If the agent's provider is down, we still get a response via the global pool
 *   - Token tracking (Phase 2) correctly attributes usage to the agent
 */
export async function callLLMForAgent(
  prompt: string,
  agentConfig: { provider: string; model: string },
  systemPrompt?: string,
  options?: LLMCallOptions
): Promise<LLMResult> {
  const { provider, model } = agentConfig

  // Step 1: Try agent's configured provider+model
  // Phase 1c fix: when native FC is enabled, models may return empty content
  // with finish_reason='tool_calls'. The success check must consider tool_calls
  // too — otherwise valid tool_calls responses would be treated as failure
  // and unnecessarily fall back to the global pool (which drops the tools param).
  const agentResult = await callLLMWithSpecificProvider(prompt, provider, model, systemPrompt, options)
  if (agentResult && (agentResult.content || (agentResult.tool_calls && agentResult.tool_calls.length > 0))) {
    const tcCount = agentResult.tool_calls?.length ?? 0
    console.log(`[LLM] Agent used configured provider: ${provider}/${model} ✓ (${tcCount} tool_calls)`)
    return agentResult
  }

  // Step 2: Fallback to global pool
  console.log(`[LLM] Agent provider ${provider}/${model} failed, falling back to global pool`)
  return callLLM(prompt, systemPrompt, 'agent-fallback', options)
}

// ==================== UTILITY EXPORTS ====================

export function getNvidiaModels(): string[] { return [...NVIDIA_MODELS] }

export function getProviderStatus(): Record<string, { keys: number; available: number; keyDetails: Array<{ index: number; available: boolean; rateLimited: boolean; exhausted: boolean; failureCount: number }> }> {
  return {
    nvidia: { keys: nvidiaPool.keyCount, available: nvidiaPool.availableCount, keyDetails: nvidiaPool.getKeyStatus() },
  }
}

// ==================== DAILY QUOTA STATUS EXPORT ====================

/** Get daily quota status for all providers.
 *  Returns per-provider info about daily quota usage, exhaustion state,
 *  and time until reset. Used by frontend to display quota warnings. */
export function getDailyQuotaStatus(): Record<string, {
  totalKeys: number
  availableKeys: number
  dailyQuotaExhaustedKeys: number
  dailyTokensUsed: number
  dailyTokenLimit: number
  dailyRequestsUsed: number
  dailyRequestLimit: number
  keys: Array<{
    index: number
    dailyQuotaExhausted: boolean
    dailyQuotaResetAt: number
    dailyTokensUsed: number
    dailyRequestCount: number
    minutesUntilReset: number
  }>
}> {
  const pools = [
    { name: 'NVIDIA', pool: nvidiaPool },
  ]
  const result: Record<string, ReturnType<typeof getDailyQuotaStatus>[string]> = {}
  for (const { name, pool } of pools) {
    const keyStatus = pool.getKeyStatus()
    const dailyLimit = PROVIDER_DAILY_TOKEN_LIMITS[name] || 0
    const requestLimit = 0
    result[name] = {
      totalKeys: pool.keyCount,
      availableKeys: pool.availableCount,
      dailyQuotaExhaustedKeys: pool.dailyQuotaExhaustedCount,
      dailyTokensUsed: pool.totalDailyTokensUsed,
      dailyTokenLimit: dailyLimit,
      dailyRequestsUsed: pool.totalDailyRequests,
      dailyRequestLimit: requestLimit,
      keys: keyStatus.map(k => ({
        index: k.index,
        dailyQuotaExhausted: k.dailyQuotaExhausted,
        dailyQuotaResetAt: k.dailyQuotaResetAt,
        dailyTokensUsed: k.dailyTokensUsed,
        dailyRequestCount: k.dailyRequestCount,
        minutesUntilReset: k.dailyQuotaResetAt > 0 ? Math.max(0, Math.round((k.dailyQuotaResetAt - Date.now()) / 60000)) : 0,
      })),
    }
  }
  return result
}
