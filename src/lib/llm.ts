/**
 * Shared LLM Calling Module for GraphRAG
 *
 * SINGLE PROVIDER architecture — NVIDIA NIM ONLY:
 *   NVIDIA NIM (4 keys × 4 docs = 16 max concurrent, auto mode)
 *
 * Architecture: NVIDIA NIM ONLY (no Mistral, Cerebras, OpenRouter)
 *   - 1 extraction core: nemotron-3-ultra-550b (primary) + openai/gpt-oss-120b
 *     (fallback — user directive 2026-09-05: "trích xuất chỉ dùng nemotron-3-ultra-550b
 *     và chatgpt-os-120b làm fall back, KHÔNG được gọi kimi-k3"). Lõi extraction
 *     KHÔNG dùng cho chat/agent — ngược lại kimi-k3 (lõi agent) KHÔNG dùng cho extraction.
 *   - 4 agent/chat cores (FALLBACK CHAIN RESTORED — user directive 2026-08-28:
 *     "thiết lập deepseek v4 pro, deepseek v4 flash, minimax lần lượt làm fall
 *     back cho k3"; kết thúc giai đoạn Kimi-only "không fallback model khác"):
 *       kimi-k3 (chính) → deepseek-v4-pro-0813 → deepseek-v4-flash-0731 → minimax-m3
 *     (MODEL-FIRST từ 2026-09-06 — chạy đủ chuỗi lõi trên 1 key trước khi chuyển key)
 *     (user directive 2026-08-27: bỏ gpt-oss-120b khỏi Agent/Chat — model này
 *     CHỈ còn dùng làm generator/judge nội bộ cho RedTeam + Eval)
 *   - glm-5.2 REMOVED 2026-08-25: NVIDIA NIM end-of-life 2026-08-21 (HTTP 410)
 *   - glm-5.3 KHÔNG tồn tại trên NIM (verified 2026-08-27: 404 mọi biến thể ID,
 *     catalog 95 models không có GLM nào — NIM đã bỏ GLM hoàn toàn)
 *   - deepseek-v4-pro: bản cũ không suffix đã 404 (2026-08-27); bản MỚI
 *     deepseek-ai/deepseek-v4-pro-0813 VERIFIED LIVE 2026-08-28 qua GET /v1/models
 *     (84 models trong catalog — user đã kiểm tra trên build.nvidia.com)
 *   - Deprecated (404): kimi-k2.6(đã quay lại catalog nhưng không dùng), glm-5.1,
 *     minimax-m2.7, qwen3.5-397b
 *
 * FAILOVER ORDER (USER DIRECTIVE 2026-09-06 — MODEL TRƯỚC, KEY SAU):
 *   "gọi lõi chính không được thì chuyển lõi fallback NGAY (cùng key), chuyển
 *    tới lõi cuối cùng mới chuyển key" — áp cho cả extraction (nemotron-550b →
 *   gpt-oss-120b) lẫn agent/chat (kimi-k3 → v4-pro → v4-flash → minimax-m3).
 *   Triển khai: callModelChainModelFirst() — mỗi sweep chạy chuỗi model trên
 *   từng key, tối đa 3 sweep, cooldown-wait giữa sweep, circuit breaker/model.
 *
 * Key assignment (AUTO mode, least-loaded-first):
 *   - Each document gets a key (0-3, auto-assigned to least-loaded key)
 *   - Key N uses NVIDIA Key N (strict binding for rate limit isolation)
 *   - If Key N is rate-limited/exhausted → fallback to next available key
 *
 * Model rotation: chuỗi model cố định thứ tự (lõi chính trước, fallback sau) —
 *   không round-robin (single-core + failover directives).
 *
 * Token tracking: NVIDIA NIM (single provider)
 *
 * (2026-09-04) Z-AI SDK PROVIDER (Task 21 tạm thời) đã gỡ bỏ khi gateway
 * ZAI 429 kéo dài 8+ giờ.
 * (2026-09-06) DỰNG LẠI theo user directive ("Z-AI SDK đã hoạt động trở
 * lại thì thiết lập tất cả các agents đều sử dụng Z-ai-sdk"): LLM_PROVIDER=zai
 * → TOÀN BỘ lõi (agent + chat + utility + extraction) route qua
 * z-ai-web-dev-sdk (GLM gateway). Xem section "Z-AI SDK PROVIDER — OPT-IN
 * QUA ENV" gần cuối file. LLM_PROVIDER=nim / không set → NIM như cũ.
 */

// ==================== TOKEN EVENT EMITTER (SSE REALTIME) ====================

import { EventEmitter } from 'events'
// Type-only import (erased lúc runtime — không tạo thêm module instance)
import type { DocumentPayload } from '@/lib/qdrant'

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
  /** EXECUTED tool calls — phân biệt nguồn khi provider chạy qua OpenCode CLI:
   *  - tool_calls: merge (native collected + text-protocol parsed) — caller
   *    cũ (goal-loop hybrid bridge) dùng để đếm evidence.
   *  - executed_tool_calls: CHỈ những tool ĐÃ ĐƯỢC inner loop của OpenCode CLI
   *    thực thi thật (native write/bash/read + tmo_* bridge gọi /api/tools/execute).
   *    Caller cần bằng chứng THỰC THI (vd self-direction receipts) dùng field
   *    này — KHÔNG thực thi lại (chống double-execution). (fix 2026-09-25) */
  executed_tool_calls?: LLMToolCall[]
  /** OpenAI-style finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
   *  Useful for Phase 1c dual-mode logic (workflow-engine.ts). */
  finish_reason?: string | null
  /** 2026-10 PROCESS INTEGRITY — reasoning/thinking parts từ OpenCode CLI
   *  (trước đây parse xong CHỈ log rồi vứt — Thought Process panel mất hết
   *  suy nghĩ trung gian của agent chạy qua CLI). */
  reasoning?: string
  /** 2026-10 PROCESS INTEGRITY — kết quả THẬT của tool inner loop CLI đã thực
   *  thi (tên TMO + output/error/status thật). Trước đây goal-loop MÙ về kết
   *  quả CLI: hard-code success=true cho mọi call → stall brake vô hiệu +
   *  evaluator chỉ thấy chuỗi generic → lặp chu kỳ không tiến triển + đánh
   *  giá hời hợt (user report 2026-10). Giờ: kết quả thật về evidence +
   *  transcript của vòng sau. */
  executed_tool_results?: ExecutedToolResult[]
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

/** 2026-10 PROCESS INTEGRITY — kết quả 1 tool call đã được inner loop
 *  OpenCode CLI thực thi (event shape probe 2026-09-25: part.tool +
 *  part.state.{status,input,output,error,time}). Goal-loop dùng để ghi
 *  evidence đúng success/fail + đẩy kết quả về transcript. */
export interface ExecutedToolResult {
  /** callId gốc từ CLI (tool_call_id) — rỗng nếu CLI không phát. Goal-loop
   *  match kết quả với call theo id TRƯỚC (chính xác kể cả 2 call cùng tên
   *  khác args), fallback theo tên TMO. (2026-10) */
  callId: string
  /** Tên tool chuẩn TMO (đã map alias tmo_ prefix + native qua toolMap) */
  name: string
  /** Tên tool gốc CLI (bash/write/tmo_shell...) — debug/truy vết */
  cliName: string
  /** Args đã chạy (object đã parse) */
  args: Record<string, unknown>
  /** Output thật (bounded ~2000 chars) */
  output: string
  /** Error text khi status='error' */
  error?: string
  /** status từ CLI ('completed' | 'error' | 'running' | ...) */
  status: string
  /** success = status !== 'error' && không có error */
  success: boolean
  /** Thời lượng (ms) — từ state.time.start/end khi CLI báo */
  durationMs: number
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
  /** USER DIRECTIVE 2026-08-31 — dừng sớm chuỗi xoay vòng key.
   *  Callback được kiểm tra TRƯỚC MỖI attempt gọi API; trả về true → dừng xoay vòng
   *  ngay lập tức (ví dụ: người dùng bấm Dừng tác vụ → ReAct loop hủy mọi LLM call
   *  đang chờ). Không bắt buộc — undefined = xoay vòng chạy đủ chu kỳ. */
  abortCheck?: () => boolean
  /** FIX 2026-09-25 (E2E tool audit): callLLMForAgent đã thử zen HTTP + CLI fail
   *  rồi mới fallback callLLM('agent-fallback') — set cờ này để KHÔNG spawn thêm
   *  CLI lần 2 trong utility zen path (tiết kiệm ~40-60s + RAM). */
  skipZenUtility?: boolean
  /** 2026-09-26 FIX (Tool health audit): sessionId của agent run đang chạy —
   *  truyền qua env TMO_SESSION_ID cho OpenCode CLI bridge (.opencode/tools/
   *  _tmo-common.ts) để tool tmo_* thực thi trong inner loop CLI ghi ToolMetric
   *  ĐÚNG session (trước đây luôn '' → metrics rơi vào session 'unknown', tách
   *  khỏi run thật — thấy rõ trong Database > Analytics > Tool health). */
  sessionId?: string | null
  /** 2026-10-20 TASK 20 (fix GAP runId): runId của agent run đang chạy — truyền
   *  qua env TMO_RUN_ID cho CLI bridge để todo_write từ inner loop CLI được gắn
   *  ĐÚNG run (buildRunTodosBlock + auto-complete query theo sessionId+runId;
   *  trước đây todos CLI lưu runId=null → TODO block chu kỳ sau LUÔN RỖNG). */
  runId?: string | null
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
 *  NOTE: For EXTRACTION models, rotation is DISABLED (user Option C — 2026-08-21,
 *  reaffirmed as single-core directive 2026-08-25).
 *  nemotron-3-ultra-550b is the ONLY extraction core.
 */
function getRotatedModels(provider: string, models: string[]): string[] {
  // EXTRACTION models: no rotation — the single nemotron-550b core
  // Compare by reference — if it's the extraction list, skip rotation
  if (models === NVIDIA_EXTRACTION_MODELS) {
    return models // Fixed order: [nemotron-550b (primary), gpt-oss-120b (fallback)]
  }
  // AGENT/CHAT models (MODEL POLICY 2026-08-25, fallback chain 2026-08-28):
  // no rotation — kimi-k3 is the DEFAULT for every agent; the others are
  // sequential failover backups (not load-balanced), so the order must stay fixed.
  if (models === NVIDIA_AGENT_MODELS) {
    return models // Always [kimi-k3, v4-pro, v4-flash, minimax]
  }
  // Legacy lists: rotate as before
  const offset = modelRotationCounters[provider] % models.length
  modelRotationCounters[provider]++
  if (offset === 0) return models // No rotation needed
  return [...models.slice(offset), ...models.slice(0, offset)]
}

/** NVIDIA NIM EXTRACTION models (user directive 2026-09-05):
 *  CHÍNH SÁCH: trích xuất tài liệu dùng nemotron-3-ultra-550b làm LÕI CHÍNH,
 *  openai/gpt-oss-120b ("chatgpt-os-120b") làm LÕI FALL BACK — KHÔNG BAO GIỜ
 *  dùng kimi-k3 cho bất kỳ tác vụ trích xuất tài liệu nào.
 *  Thứ tự cố định: primary trước, fallback sau (không rotation).
 *
 *  nvidia/nemotron-3-ultra-550b-a55b: 550B MoE (55B active), mạnh nhất ✓ VERIFIED 2026-08-21
 *  openai/gpt-oss-120b: fallback ✓ CÒN TỒN TẠI trên NIM (verified 2026-09-05 qua
 *  GET /v1/models — đã từng bị bỏ khỏi Agent/Chat theo directive cũ 2026-08-27,
 *  giờ quay lại làm lõi extraction fallback theo directive mới 2026-09-05)
 *
 *  Đã bỏ: llama-3.1-nemotron-ultra-253b-v1 (404 NOT FOUND — deprecated 2026-08-21)
 *  Đã bỏ: nemotron-4-340b-instruct (404 NOT FOUND — deprecated 2026-08-21)
 *  Đã bỏ: meta/llama-3.3-70b-instruct (chất lượng trích xuất kém hơn 550b)
 */
const NVIDIA_EXTRACTION_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  // ⚠️ 2026-10-16: openai/gpt-oss-120b → HTTP 410 GONE trên cả 4 key (matrix
  // test) — NIM đã EOL model này. Giữ trong mảng theo user directive 2026-09-05
  // (extraction chỉ dùng nemotron + gpt-oss); fallback fail-fast 410 ~0.1s,
  // sweep vẫn hoàn tất qua nemotron (4/4 key OK). Chờ user chỉ đạo thay lõi.
  'openai/gpt-oss-120b',
]

/** NVIDIA NIM AGENT/CHAT models — MINIMAX-M3 CHÍNH (user directive 2026-10-16:
 *  minimax-m3 tạm làm lõi chính — duy nhất khả dụng sau matrix test 4 lõi × 4
 *  key 09:11 UTC: kimi/ds-pro/ds-flash đều HANG 0 bytes sau 60s). Thứ tự cố
 *  định (không rotation): minimax-m3 chính, fallback tuần tự kimi-k3 → ds-pro
 *  → ds-flash (directive gốc 2026-08-28 về fallback được bảo toàn).
 *
 *  Verified LIVE 2026-08-28 qua GET /v1/models (84 models):
 *    moonshotai/kimi-k3 ✓ | deepseek-ai/deepseek-v4-pro-0813 ✓ (BẢN MỚI —
 *    bản cũ không suffix đã 404 từ 2026-08-27) | deepseek-ai/deepseek-v4-flash-0731 ✓
 *    | minimaxai/minimax-m3 ✓
 *  Verified 2026-08-25: kimi-k3 ~16s | deepseek ~27s | minimax ~0.3s
 *  Matrix 2026-10-16: minimax-m3 4/4 key OK (6-44s) · 3 lõi kia HANG */
const NVIDIA_AGENT_MODELS = [
  'minimaxai/minimax-m3',
  'moonshotai/kimi-k3',
  'deepseek-ai/deepseek-v4-pro-0813',
  'deepseek-ai/deepseek-v4-flash-0731',
]

/**
 * NVIDIA_MODELS (updated 2026-10-16): = NVIDIA_AGENT_MODELS (4 lõi chat —
 * minimax-m3 chính + 3 lõi fallback kimi-k3/ds-pro/ds-flash).
 * nemotron-3-ultra-550b KHÔNG thuộc danh sách này — lõi extraction duy nhất.
 * Deprecated (404): kimi-k2.6 (đã quay lại catalog, không dùng), glm-5.1,
 * minimax-m2.7, qwen3.5-397b; deepseek-v4-pro bản cũ (bản mới: -0813)
 */
// Alias of NVIDIA_AGENT_MODELS — same 4 chat cores, same failover order.
// (Kept as a separate export because getNvidiaModels() + the pool log line
// reference NVIDIA_MODELS.)
const NVIDIA_MODELS = [...NVIDIA_AGENT_MODELS]

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
// Dùng đúng type của export `db` (PrismaClient instance, không phải class) —
// InstanceType<typeof db> sai vì db đã là instance.
let cachedDb: typeof import('@/lib/db')['db'] | null = null

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
    const allActiveDocs: Array<{ id: string; payload: DocumentPayload }> = []

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
        // best-effort cleanup — qua retryDbOp để tái sử dụng cached PrismaClient
        // (trước đây tham chiếu `db` không tồn tại → bị catch nuốt, row không bao giờ bị xóa)
        retryDbOp(db => db.jobQueue.delete({ where: { id: `key-${ka.keyIndex}-doc-${docId.slice(0, 8)}` } })).catch(() => {})
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
  // public (type-level only) — helper module-level waitForRateLimitCooldown() cần đọc trạng thái key
  keys: ProviderKeyInfo[]
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

  /** USER DIRECTIVE 2026-08-31 — truy cập key THÔ tại index cho cơ chế xoay vòng
   *  key mới (callModelWithKeyRotation). KHÔNG bỏ qua key đang cooldown/exhausted —
   *  chính sách xoay vòng của user yêu cầu MỖI key đều được thử đủ 3 lần (kể cả
   *  key vừa 429 — vì khi quay vòng qua 3 key khác xong, quota RPM có thể đã reset).
   *  Chỉ trả về null với key rỗng (thiếu env var). */
  getRawKeyInfo(index: number): ProviderKeyInfo | null {
    if (index < 0 || index >= this.keys.length) return null
    const keyInfo = this.keys[index]
    return keyInfo.key ? keyInfo : null
  }

  /** Số lượng key hợp lệ (không rỗng) trong pool */
  get validKeyCount(): number { return this.keys.filter(k => !!k.key).length }

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
// Banner cấu hình chain — tắt khi LLM_QUIET_INIT=1 (scripts/test-llm-model.ts
// set env này TRƯỚC khi dynamic import; user feedback 2026-09-03: trong output
// test dòng này chỉ là nhiễu cấu hình, không mang thông tin kết quả test.
// App runtime bình thường (không set env) vẫn log đầy đủ như cũ.
if (!process.env.LLM_QUIET_INIT) {
  // NOTE: KHÔNG bọc danh sách model trong [...] ngay sau chữ — pipeline ghi
  // dev.log strip ANSI ăn mất chuỗi "[m" (SGR reset rỗng) → "[moonshotai/..."
  // thành "oonshotai/..." (đã từng gây hiểu lầm cấu hình sai trong rà soát
  // 2026-09-04). Dùng ": model1 → model2" không bracket.
  console.log(`[LLM] NVIDIA: agent/chat minimax-m3 (chính — TẠM THỜI, user directive 2026-10-16: duy nhất khả dụng) + FALLBACK CHAIN: ${NVIDIA_AGENT_MODELS.slice(1).join(' → ')} + 2 extraction cores (nemotron-550b chính → gpt-oss-120b fallback [410 GONE từ 2026-10-16] — lõi agent KHÔNG dùng cho extraction, user directive 2026-09-05)`)
}

// ==================== KIMI K3 MODEL POLICY + NVIDIA KEY ROTATION ====================
// USER DIRECTIVE 2026-08-31: "mọi Agents, mọi tác vụ từ giờ sẽ sử dụng lõi Kimi k3,
// nếu gặp vấn đề thì chuyển API key của NVIDIA NIM, xoay vòng mỗi key 3 đủ 3 lần thì
// mới dừng lại... tới khi chuyển qua cả 4 key lại về key đầu tiên, đến khi mỗi key
// đều đủ 3 lần thì mới dừng lại"
//
// USER DIRECTIVE 2026-08-28 (MỚI NHẤT — thay thế Kimi-only): "tôi nhớ khi còn
// thiết lập fall back thì việc gọi K3 vẫn ổn định, hiện tại hãy thử thiết lập
// deepseek v4 pro (đã kiểm tra trên build.nvidia.com), deepseek v4 flash,
// minimax lần lượt làm fall back cho k3" — khôi phục FALLBACK CHAIN.
//
// Chính sách:
//   1. MỌI agents + MỌI tác vụ (chat/ReAct/team/cron...) dùng lõi kimi-k3 làm
//      lõi CHÍNH — cấu hình model riêng của từng agent bị override.
//      (Tắt bằng ENFORCE_KIMI_K3=false để quay về cấu hình per-agent.)
//   2. Khi 1 attempt gặp vấn đề (429 rate-limit, 5xx, 401/403, timeout, network...)
//      → CHUYỂN NGAY sang key kế tiếp: key1→key2→key3→key4→key1→key2→...
//   3. MỖI key được thử tối đa KEY_FAILURES_PER_KEY (3) lần trong 1 chuỗi xoay vòng.
//      Chỉ khi MỌI key đều đã fail đủ 3 lần (4 key × 3 = 12 attempts) mới dừng.
//   4. FALLBACK CHAIN (user directive 2026-08-28): khi kimi-k3 cạn chuỗi xoay vòng
//      key → chuyển TUẦN TỰ sang deepseek-v4-pro-0813 → deepseek-v4-flash-0731 →
//      minimax-m3 (mỗi lõi lại xoay vòng đủ 4 key × 3 lần). Lý do: khi còn
//      fallback, kimi-k3 ổn định vì traffic được giảm tải khi 429; chính sách
//      Kimi-only trước đó khiến mọi call dồn vào kimi-k3 → 4 key cháy đồng loạt
//      (NIM chặn kimi-k3 dễ hơn các model khác — 40 RPM + RPD thấp hơn mặt bằng).
//   5. Extraction pipeline dùng 2 lõi riêng (user directive 2026-09-05):
//      nemotron-3-ultra-550b (chính) + openai/gpt-oss-120b (fallback) — qua
//      callLLMSlot, TUYỆT ĐỐI không dùng kimi-k3; override bằng env
//      EXTRACTION_MODEL / EXTRACTION_FALLBACK_MODEL nếu muốn.

/** Lõi CHÍNH cho MỌI agents, MỌI tác vụ.
 *
 *  ⚠️ USER DIRECTIVE 2026-10-16 (TẠM THỜI): "minimax-m3 làm lõi AI chính cho
 *  tất cả các Agents — thiết lập tạm thời, minimax-M3 hiện là lựa chọn duy
 *  nhất". Ma trận test 4 lõi × 4 key (scripts-tmp/nim-matrix.ts, HTTP trực
 *  tiếp NIM, 09:11 UTC): kimi-k3 0/4 key (HANG 60s 0 bytes) · ds-v4-pro 0/4
 *  (HANG) · ds-v4-flash 0/4 (HANG) · minimax-m3 4/4 key OK (6-44s).
 *  → Lõi chính = minimaxai/minimax-m3; kimi-k3 + deepseek-v4 xuống chuỗi
 *  fallback (NIM hồi thì tự dùng lại qua fallback, hoặc user đổi
 *  AGENT_PRIMARY_MODEL về moonshotai/kimi-k3 khi chỉ đạo).
 *  Override qua env: AGENT_PRIMARY_MODEL.
 *
 *  (Lịch sử) 2026-09-30: 3 lõi đầu NIM HANG — từng tạm đổi minimax làm chính.
 *  (Lịch sử) 2026-08-31: user chỉ định kimi-k3 làm lõi chính + chain
 *  ds-v4-pro → ds-v4-flash → minimax-m3 (directive 2026-08-28/2026-09-06).
 *  Đổi lại bất kỳ lúc nào qua env AGENT_PRIMARY_MODEL / AGENT_FALLBACK_CHAIN
 *  (không cần sửa code).
 */
export const AGENT_PRIMARY_MODEL =
  process.env.AGENT_PRIMARY_MODEL?.trim() || 'minimaxai/minimax-m3'

/** @deprecated alias (2026-09-30) — KIMI_K3_MODEL giờ = AGENT_PRIMARY_MODEL
 *  (nhiều import dùng tên cũ; ngữ nghĩa "lõi chính" giữ nguyên). */
export const KIMI_K3_MODEL = AGENT_PRIMARY_MODEL

/** Chuỗi fallback tuần tự cho lõi chính (failover MODEL-FIRST — từng model trên
 *  cùng key trước khi chuyển key).
 *  USER DIRECTIVE 2026-10-16: minimax-m3 là lõi chính (duy nhất khả dụng) →
 *  chuỗi fallback = kimi-k3 (fallback #1 — khi NIM hồi, kimi là lõi mạnh nhất
 *  tự phục hồi trước) → deepseek-v4-pro-0813 (#2) → deepseek-v4-flash-0731 (#3).
 *  Override qua env AGENT_FALLBACK_CHAIN (CSV — vd "moonshotai/kimi-k3,
 *  deepseek-ai/deepseek-v4-pro-0813"). Lõi chính fail → chuyển NGAY lõi fallback
 *  kế trên CÙNG key; chỉ khi cả chuỗi fail trên key đó mới chuyển key (chain
 *  restart từ lõi chính). deepseek-v4-pro-0813 = bản verified live 2026-08-28. */
export const AGENT_FALLBACK_CHAIN: string[] = (() => {
  const csv = process.env.AGENT_FALLBACK_CHAIN?.trim()
  if (csv) {
    const parsed = csv.split(',').map(s => s.trim()).filter(Boolean)
    if (parsed.length > 0) return parsed
  }
  return [
    'moonshotai/kimi-k3',
    'deepseek-ai/deepseek-v4-pro-0813',
    'deepseek-ai/deepseek-v4-flash-0731',
  ]
})()

/** Số lần fail tối đa MỖI key trong 1 chuỗi xoay vòng (user: "mỗi key 3 đủ 3 lần") */
export const KEY_FAILURES_PER_KEY = 3

/** Tổng budget thời gian cho TOÀN BỘ chuỗi xoay vòng key của 1 model (ms).
 *  429/auth fail rất nhanh nên chuỗi 12 attempts thường hoàn tất trong vài giây;
 *  budget chỉ chặn trường hợp pathological (mọi attempt đều timeout 240s).
 *  Override bằng env KEY_ROTATION_BUDGET_MS. */
const KEY_ROTATION_BUDGET_MS = parseInt(process.env.KEY_ROTATION_BUDGET_MS || '900000', 10) // 15 phút

/** Model trích xuất — override được qua env (mặc định giữ nemotron-550b) */
const EXTRACTION_MODEL_OVERRIDE = process.env.EXTRACTION_MODEL || ''

/** Chính sách Kimi k3 có đang bật không? (mặc định BẬT — user directive 2026-08-31) */
export function isKimiK3Enforced(): boolean {
  return (process.env.ENFORCE_KIMI_K3 ?? 'true').trim().toLowerCase() !== 'false'
}

/** (KHÔI PHỤC 2026-08-28) Chuỗi backup cores deepseek/minimax ĐƯỢC DÙNG ở
 *  enforced path qua callAgentModelWithFallbackChain() — xem AGENT_FALLBACK_CHAIN
 *  ở trên. Giai đoạn Kimi-only "không fallback model khác" đã kết thúc. */

/**
 * Gọi lõi agent theo chuỗi MODEL-FIRST (USER DIRECTIVE 2026-09-06):
 *   kimi-k3 (chính) → deepseek-v4-pro-0813 → deepseek-v4-flash-0731 → minimax-m3
 * Lõi chính fail → chuyển NGAY lõi fallback kế (CÙNG key); chỉ khi TOÀN BỘ chuỗi
 * lõi fail trên 1 key mới CHUYỂN KEY (chain khởi động lại từ lõi chính).
 * Circuit breaker hard-block giúp lõi bị NIM chặn cứng 429-instant fail NGAY (ms).
 * abortCheck được kiểm tra TRƯỚC MỖI attempt — người dùng bấm Dừng cắt ngang ngay.
 */
async function callAgentModelWithFallbackChain(
  prompt: string,
  systemPrompt: string | undefined,
  options: LLMCallOptions | undefined,
  taskLabel: string,
): Promise<LLMResult> {
  // FIX (R2-a #9): dedup — AGENT_PRIMARY_MODEL trùng entry trong AGENT_FALLBACK_CHAIN
  // (vd user set lại kimi-k3 làm primary) → không đốt 2 lần attempt cùng model/key.
  const chain = [KIMI_K3_MODEL, ...AGENT_FALLBACK_CHAIN].filter((m, i, arr) => arr.indexOf(m) === i)

  // Người dùng bấm Dừng → cắt ngang chuỗi NGAY, không đốt call/key
  if (options?.abortCheck && options.abortCheck()) {
    console.log(`[LLM] Agent fallback chain (task "${taskLabel}"): HỦY (abortCheck) trước khi gọi`)
    return {
      content: '',
      provider: 'none',
      model: KIMI_K3_MODEL,
      error: `Task "${taskLabel}" aborted by user`,
    }
  }

  const result = await callModelChainModelFirst(
    chain,
    prompt,
    systemPrompt,
    options,
    { taskLabel: `agent:${taskLabel}` },
  )
  if (result && (result.content || (result.tool_calls && result.tool_calls.length > 0))) {
    if (result.model !== KIMI_K3_MODEL) {
      console.log(`[LLM] Agent fallback chain (task "${taskLabel}"): lõi ${result.model} THÀNH CÔNG (fallback) — kimi-k3 đã fail`)
    }
    return result
  }

  // Toàn bộ chuỗi thất bại — báo lỗi trung thực kèm trạng thái circuit breaker
  // FIX (breaker-audit #5): không hardcode "(429 instant trên TẤT CẢ key)" —
  // breaker có thể trip vì timeout-hang; dẫn đầu bằng nguyên nhân thật + số
  // phút còn lại để user không bị dẫn sai hướng check hạn mức NIM.
  const breaker = isModelHardBlocked(KIMI_K3_MODEL)
  const breakerEntry = modelBlockBreakers.get(KIMI_K3_MODEL)
  const breakerRemainingMin = breakerEntry ? Math.max(1, Math.ceil((breakerEntry.blockedUntil - Date.now()) / 60000)) : 0
  return {
    content: '',
    provider: 'none',
    model: KIMI_K3_MODEL,
    error: breaker.blocked
      ? `🔴 Lõi chính ${KIMI_K3_MODEL} đang bị circuit breaker chặn (còn ~${breakerRemainingMin} phút). ${breaker.reason} Đã thử toàn bộ chuỗi fallback (${AGENT_FALLBACK_CHAIN.join(', ')}) — cũng thất bại.`
      : `CẢ chuỗi lõi agent đều thất bại sau ${KEY_FAILURES_PER_KEY} sweep model-first (${chain.join(' → ')} trên từng key — chỉ chuyển key khi cả chuỗi fail). Vui lòng kiểm tra hạn mức NVIDIA NIM (build.nvidia.com → Credits) hoặc API keys.`,
  }
}

/** Kết quả 1 attempt gọi NIM thô */
type NvidiaAttemptStatus =
  | 'success'
  | 'rate_limited'     // 429 tạm thời (RPM)
  | 'daily_quota'      // 429 hết hạn mức ngày → key chết tới nửa đêm
  | 'auth_error'       // 401/403 — key sai/hết hạn
  | 'server_error'     // 5xx
  | 'bad_request'      // 400/413/414/422/431 — deterministic, retry cùng body vô nghĩa
  | 'timeout'          // hết timeoutMs
  | 'network_error'    // fetch throw khác
  | 'empty_response'   // 200 nhưng không có content lẫn tool_calls

/**
 * SURROGATE SANITIZE (fix NIM 400-block 2026-09-30) — loại lone surrogate
 * (nửa emoji do slice() cắt đôi surrogate pair) khỏi string trước khi vào
 * JSON body của NIM. NIM (serde_json) reject JSON chứa lone surrogate escape
 * ("Failed to deserialize... unexpected end of hex escape") → cả chuỗi model
 * fail 400 trên MỌI key → agent "lỗi không rõ nguyên nhân".
 * Nguồn gốc: mọi .slice() trên text chứa emoji (tool result preview, digest,
 * schema description...) đều có thể tạo lone surrogate — sanitize TẠI BIÊN
 * GIỚI là lưới an toàn cho tất cả đường (đừng phải sửa từng slice).
 */
function sanitizeLoneSurrogates(s: string): string {
  if (!s) return s
  // High surrogate KHÔNG theo sau bởi low surrogate → xóa
  let out = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
  // Low surrogate KHÔNG đứng sau high surrogate → xóa
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  return out
}

/**
 * FIX (review R2-a #1, 2026-08-31): JSON round-trip là NO-OP cho lone surrogate
 * (well-formed JSON.stringify escape `\udXXX` thành TEXT — regex tìm ký tự surrogate
 * không thấy gì; JSON.parse trả về lone surrogate nguyên vẹn → body cuối cùng vẫn
 * bị NIM 400-block). Thay bằng deep-walk: sanitize TỪNG string field trong schema
 * (function.description, parameter.description, enum values...) TRƯỚC khi build body.
 */
function sanitizeToolSchemasDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeLoneSurrogates(value) as unknown as T
  if (Array.isArray(value)) return value.map(v => sanitizeToolSchemasDeep(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeToolSchemasDeep(v)
    }
    return out as unknown as T
  }
  return value
}

/**
 * 1 attempt gọi NVIDIA NIM với 1 key cụ thể + 1 model cụ thể.
 * Trả về status + result (khi success). KHÔNG đụng pool state — caller quyết định.
 */
async function attemptNvidiaOnce(params: {
  keyInfo: { key: string; keyIndex: number }
  model: string
  prompt: string
  systemPrompt: string | undefined
  temperature: number
  maxTokens: number
  timeoutMs: number
  tools?: LLMTool[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  agentId?: string
  agentName?: string
}): Promise<{ status: NvidiaAttemptStatus; result?: LLMResult; httpStatus?: number; errorMessage?: string }> {
  const { keyInfo, model, prompt, systemPrompt, temperature, maxTokens, timeoutMs } = params

  // FIX 400-block: lone surrogate trong prompt/systemPrompt → NIM reject body.
  // Sanitize tại biên giới (mọi prompt nguồn đã slice cắt emoji đôi đều được chữa).
  const cleanPrompt = sanitizeLoneSurrogates(prompt)
  const cleanSystem = systemPrompt !== undefined ? sanitizeLoneSurrogates(systemPrompt) : undefined

  const messages = [
    ...(cleanSystem ? [{ role: 'system' as const, content: cleanSystem }] : []),
    { role: 'user' as const, content: cleanPrompt },
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }
    if (params.tools && params.tools.length > 0) {
      // FIX 400-block (R2-a #1): deep-walk sanitize MỌI string trong tool schemas —
      // JSON round-trip cũ là no-op (stringify escape surrogate thành text \udXXX,
      // regex không match; parse trả lại lone surrogate → NIM vẫn reject).
      try {
        body.tools = sanitizeToolSchemasDeep(params.tools)
      } catch {
        body.tools = params.tools
      }
      body.tool_choice = params.tool_choice ?? 'auto'
    }

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyInfo.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    // FIX (R2-a #4): KHÔNG clearTimeout ngay sau headers — body download
    // (response.json()/text()) cũng phải nằm trong vùng phủ của abort timer
    // (mid-body stall = treo vô hạn trước đây). Timer được dọn trong finally.

    if (response.status === 429) {
      let errorBody = ''
      try { errorBody = await response.text() } catch { /* ignore */ }
      const quotaCheck = parse429ForDailyQuota('NVIDIA', errorBody)
      return {
        status: quotaCheck.isDailyQuota ? 'daily_quota' : 'rate_limited',
        httpStatus: 429,
        errorMessage: errorBody.slice(0, 200),
      }
    }

    if (response.ok) {
      const data = await response.json() as {
        choices: Array<{
          message: {
            content: string
            tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
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
        // Token tracking — giống tryProviderWithSlotKey (per-slot + per-agent)
        if (totalTokens > 0) addTokensUsed(totalTokens, 'nvidia', keyInfo.keyIndex, model)
        if (totalTokens > 0 && params.agentId && params.agentName) {
          addTokensUsedByAgent(
            totalTokens,
            data.usage?.prompt_tokens ?? 0,
            data.usage?.completion_tokens ?? 0,
            'nvidia',
            model,
            params.agentId,
            params.agentName,
          )
        }
        return {
          status: 'success',
          result: {
            content: content ?? '',  // NIM trả content rỗng khi finish_reason='tool_calls'
            provider: 'nvidia',
            model,
            tokensUsed: totalTokens,
            tool_calls: nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
            finish_reason: finishReason,
          },
        }
      }
      return { status: 'empty_response', httpStatus: 200 }
    }

    if (response.status === 401 || response.status === 403) {
      return { status: 'auth_error', httpStatus: response.status, errorMessage: `HTTP ${response.status}` }
    }
    if (response.status >= 500) {
      return { status: 'server_error', httpStatus: response.status, errorMessage: `HTTP ${response.status}` }
    }
    // 4xx khác (400 bad request...) — xử lý như lỗi không thể retry cùng key/model
    // FIX 2026-09-30: đọc ERROR BODY (trước đây chỉ "HTTP 400" không lý do —
    // chẩn đoán sự cố 400-block của goal-loop phải đoán mò). Cap 300 chars.
    let errBody = ''
    try { errBody = (await response.text()).slice(0, 300) } catch { /* ignore */ }
    // FIX (R2-a #7): 4xx deterministic (body hỏng/quá lớn) → 'bad_request' —
    // caller fail-fast thay vì xoay 4 key × 3 sweep retry cùng body vô nghĩa.
    // FIX (audit 2026-10-15): thêm 404 — model-not-found là deterministic THEO
    // MODEL (NIM đã 404 glm-5.3, deepseek-v4-pro bản cũ 2026-08-27): key khác
    // retry cùng model-name cũng 404 y hệt. Trước đây 404 rơi vào 'server_error'
    // → đốt tới 12 attempts + soft-mark cooldown oan 4 key trước khi fail.
    const isDeterministic4xx = response.status === 400 || response.status === 404 || response.status === 413 || response.status === 414 || response.status === 422 || response.status === 431
    return {
      status: isDeterministic4xx ? 'bad_request' : 'server_error',
      httpStatus: response.status,
      errorMessage: `HTTP ${response.status}${errBody ? `: ${errBody}` : ''}`,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'timeout', errorMessage: `timeout ${timeoutMs / 1000}s` }
    }
    return { status: 'network_error', errorMessage: err instanceof Error ? err.message : 'unknown' }
  } finally {
    // FIX (R2-a #4): dọn timer tại MỌI lối ra — phủ cả body-read (json/text)
    // nằm sau response headers (fetch abort signal cắt được body đang treo).
    clearTimeout(timer)
  }
}

/**
 * Gọi 1 model NVIDIA NIM duy nhất với XOAY VÒNG KEY (chính sách 2026-08-31).
 * TỪ 2026-09-06 chỉ còn dùng cho đường model-override (callLLM options.model —
 * eval judges) vì extraction/agent đã chuyển sang chuỗi model-first
 * callModelChainModelFirst(). Với 1 model đơn, xoay vòng key là chiều fallback
 * duy nhất nên thứ tự "key-first" ở đây vẫn hợp lệ.
 *   key1→key2→key3→key4→key1→key2→key3→key4→key1→key2→key3→key4
 *   (mỗi key đúng 3 lần; daily-quota/auth-dead key bị loại ngay trong chuỗi).
 *   SUCCESS ở attempt nào → trả ngay. Chỉ trả null khi MỌI key fail đủ 3 lần
 *   (hoặc hết budget / abortCheck).
 */

/**
 * RATE-LIMIT COOLDOWN WAIT — critical fix for "agents stop mid-task" bug.
 *
 * When ALL keys in the pool are dead due to rate-limiting (429 RPM exceeded),
 * this function WAITS for the earliest cooldown reset instead of immediately
 * giving up. The NVIDIA NIM API enforces ~40 RPM per key with a 30-45s cooldown
 * on 429. Without this wait, the agent would try all 4 keys × 3 attempts = 12
 * rapid retries, all fail (keys still cooling down), and the agent step errors
 * out — causing the "agent stops after a few iterations" bug.
 *
 * Behavior:
 * 1. Check if ALL dead keys are rate-limited (NOT daily-quota or auth-error —
 *    those are permanent and waiting won't help).
 * 2. Find the earliest rateLimitResetAt among dead keys.
 * 3. Sleep until that time (polling every 3s), up to a max of 90s.
 * 4. If a key becomes available → return true (caller retries).
 * 5. If max wait exceeded or keys are permanently dead → return false (caller gives up).
 *
 * @param pool The NVIDIA key pool
 * @param abortCheck Optional cancellation check (user pressed Stop)
 * @returns { recovered, waitedMs } — recovered=true nếu có key khả dụng lại;
 *   waitedMs = thời gian THỰC SỰ đã ngủ chờ cooldown (0 nếu trả về ngay).
 *
 * FIX (breaker-audit #1): trả kèm waitedMs để caller phân biệt "cooldown đã
 * reset" THẬT (đủ dài) với "reset-time cũ rồi nên trả ngay" (vacuous cycle 0s)
 * — không đếm cooldown-cycle ảo cho circuit breaker.
 */
async function waitForRateLimitCooldown(
  pool: ProviderKeyPool,
  abortCheck?: () => boolean,
): Promise<{ recovered: boolean; waitedMs: number }> {
  // Check if ALL keys are rate-limited (temporary) vs permanently dead (daily-quota/auth)
  const allKeys = pool.keys.filter(k => !!k.key)
  if (allKeys.length === 0) return { recovered: false, waitedMs: 0 }

  const rateLimitedKeys = allKeys.filter(k => k.rateLimited && !k.dailyQuotaExhausted)
  const permanentlyDeadKeys = allKeys.filter(k => k.dailyQuotaExhausted)

  // If all keys are permanently dead (daily quota), waiting won't help
  if (permanentlyDeadKeys.length === allKeys.length) {
    console.warn(`[LLM] ⏳ waitForRateLimitCooldown: ALL keys daily-quota-exhausted — waiting won't help, giving up`)
    return { recovered: false, waitedMs: 0 }
  }

  // If no keys are rate-limited, nothing to wait for
  if (rateLimitedKeys.length === 0) return { recovered: false, waitedMs: 0 }

  // Find the earliest reset time
  const now = Date.now()
  const earliestReset = Math.min(...rateLimitedKeys.map(k => k.rateLimitResetAt))
  const waitMs = Math.max(0, earliestReset - now)

  if (waitMs <= 0) {
    // A key should already be available — reset and signal retry
    console.log(`[LLM] ⏳ waitForRateLimitCooldown: rate-limit already expired — retrying immediately`)
    return { recovered: true, waitedMs: 0 }
  }

  // Cap the wait at 90s — don't hang forever
  const cappedWait = Math.min(waitMs, 90_000)
  console.log(`[LLM] ⏳ waitForRateLimitCooldown: ALL ${rateLimitedKeys.length} NVIDIA keys rate-limited — waiting ${Math.ceil(cappedWait / 1000)}s for cooldown reset (abortCheck: ${!!abortCheck})`)

  // Poll every 3s until the key is available or max wait exceeded
  const pollInterval = 3000
  const maxWaitUntil = now + cappedWait
  // NOTE (fix 2026-08-27): `rateLimited` chỉ được reset lười (lazy) trong
  // getNextKey()/getKeyByIndex() — trong lúc chờ đây KHÔNG ai gọi 2 hàm đó,
  // nên phải check theo THỜI GIAN (rateLimitResetAt) chứ không đọc cờ stale.
  // Trước fix: solo-wait 90s rồi give up dù cooldown 30s đã lâu hết.
  const isKeyAvailable = (k: { key: string; rateLimited: boolean; rateLimitResetAt: number; exhausted: boolean; dailyQuotaExhausted: boolean }) =>
    !!k.key && (!k.rateLimited || Date.now() >= k.rateLimitResetAt) && !k.exhausted && !k.dailyQuotaExhausted
  while (Date.now() < maxWaitUntil) {
    if (abortCheck && abortCheck()) {
      console.log(`[LLM] ⏳ waitForRateLimitCooldown: aborted by user during wait`)
      return { recovered: false, waitedMs: Date.now() - now }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval))
    // Check if any key has recovered (time-aware — clears stale flags)
    const recoveredKeys = allKeys.filter(k => k.key && k.rateLimited && Date.now() >= k.rateLimitResetAt)
    for (const k of recoveredKeys) {
      k.rateLimited = false
      k.failureCount = 0
    }
    const recovered = allKeys.some(k => isKeyAvailable(k))
    if (recovered) {
      console.log(`[LLM] ⏳ waitForRateLimitCooldown: key recovered after ${Math.ceil((Date.now() - now) / 1000)}s — retrying`)
      return { recovered: true, waitedMs: Date.now() - now }
    }
  }

  // Final check after max wait (time-aware)
  const finalRecoveredKeys = allKeys.filter(k => k.key && k.rateLimited && Date.now() >= k.rateLimitResetAt)
  for (const k of finalRecoveredKeys) {
    k.rateLimited = false
    k.failureCount = 0
  }
  const recovered = allKeys.some(k => isKeyAvailable(k))
  if (recovered) {
    console.log(`[LLM] ⏳ waitForRateLimitCooldown: key recovered after max wait — retrying`)
    return { recovered: true, waitedMs: Date.now() - now }
  }

  console.warn(`[LLM] ⏳ waitForRateLimitCooldown: still all rate-limited after ${Math.ceil(cappedWait / 1000)}s wait — giving up`)
  return { recovered: false, waitedMs: Date.now() - now }
}

// ==================== MODEL CIRCUIT BREAKER — HARD 429 BLOCK DETECTION ====================
// (2026-08-28, root-cause của "agents không triển khai nhiệm vụ")
// NVIDIA NIM có thể chặn CỨNG một model trên TẤT CẢ key: 429 trả về NGAY LẬP TỨC
// (không Retry-After header, không hết sau cooldown 30s) trong khi CÙNG key gọi
// model khác vẫn 200 OK (verified live: moonshotai/kimi-k3 → 429 cả 4 key,
// openai/gpt-oss-120b → 200 cùng key). Chuỗi xoay vòng cũ xoay đủ 4 key × 3 lần
// + chờ cooldown lặp lại → MỖI call tốn 2.5'+ trước khi fail, goal-loop +
// fallback /api/query nhân đôi thời gian chờ → user thấy agent "đứng im".
// → Circuit breaker: sau khi cooldown đã reset ít nhất 1 lần mà sweep tiếp theo
//   vẫn TOÀN 429-instant trên mọi key → xác nhận hard-block → mở breaker
//   MODEL_BLOCK_BREAKER_MS (10'): các call sau fail NGAY (ms) với lỗi rõ ràng,
//   không đốt 15' budget mỗi call.
const MODEL_BLOCK_BREAKER_MS = Math.max(30_000, parseInt(process.env.MODEL_BLOCK_BREAKER_MS || '600000', 10) || 600_000) // 10 phút
/** Ngưỡng coi 1 response 429 là "instant reject" (server từ chối không xử lý) */
const INSTANT_429_MS = 3000
/** FIX (breaker-audit #1): 1 "cooldown cycle" chỉ được tính khi thực sự NGỦ chờ
 *  qua reset (≥30s). Trước đây wait trả về NGAY (reset-time cũ) hoặc chỉ chờ
 *  soft-cooldown 15s của 5xx cũng được đếm là "đã qua cooldown" → breaker có
 *  thể trip oan model khỏe trên 429 RPM tạm thời của pool key dùng chung. */
const REAL_COOLDOWN_CYCLE_MIN_MS = 30_000

// Task 20: breaker + strike state GẮN globalThis — llm.ts có thể được đánh giá
// nhiều instance trong 1 process (Turbopack dev: instrumentation graph tách
// khỏi route graphs — log "Provider pool" in 3 lần lúc boot là bằng chứng).
// Prober chạy từ instrumentation context phải trip breaker cho MỌI instance
// thấy được (call thật từ API routes) — pattern globalThis-singleton giống
// TokenTracker.
const gLlmBreakerState = globalThis as unknown as {
  __tmoModelBlockBreakers?: Map<string, { blockedUntil: number; reason: string; detectedAt: number }>
  __tmoModelTimeoutStrikes?: Map<string, number>
  __tmoModelTimeoutLastAt?: Map<string, number>
}
const modelBlockBreakers = gLlmBreakerState.__tmoModelBlockBreakers ?? (gLlmBreakerState.__tmoModelBlockBreakers = new Map<string, { blockedUntil: number; reason: string; detectedAt: number }>())

function isModelHardBlocked(model: string): { blocked: boolean; reason?: string } {
  const b = modelBlockBreakers.get(model)
  if (!b) return { blocked: false }
  if (Date.now() >= b.blockedUntil) {
    modelBlockBreakers.delete(model)
    return { blocked: false }
  }
  return { blocked: true, reason: b.reason }
}

function tripModelBreaker(model: string, reason: string, kind: '429-hard-block' | 'timeout-hang' = '429-hard-block'): void {
  modelBlockBreakers.set(model, {
    blockedUntil: Date.now() + MODEL_BLOCK_BREAKER_MS,
    reason,
    detectedAt: Date.now(),
  })
  // FIX (breaker-audit #5): headline phải khớp loại trip — trước đây hardcode
  // "429 instant trên mọi key" kể cả khi trip vì timeout-hang (log tự mâu
  // thuẫn, user bị dẫn sai hướng đi check hạn mức NIM cho sự cố hang).
  const headline = kind === 'timeout-hang'
    ? `model ${model} HANG phía NVIDIA NIM (nhận request nhưng 0 bytes trả về; model khác vẫn chạy)`
    : `model ${model} bị NVIDIA NIM chặn cứng (429 instant trên mọi key)`
  console.warn(`[LLM] 🔴 CIRCUIT BREAKER TRIPPED (${kind}): ${headline} — fail-fast trong ${Math.round(MODEL_BLOCK_BREAKER_MS / 60000)} phút. Lý do: ${reason}`)
}

// ==================== TASK 22 — MODEL TIMEOUT HEALTH (fast-fail khi model HANG) ====================
// Sự cố NIM 2026-08-31 (audit Task 22 phát hiện): kimi-k3 + deepseek-v4
// pro/flash HANG (0 bytes — server nhận request rồi im lặng) trong khi
// minimax-m3 vẫn OK. Timeout KHÔNG phải 429-instant nên không trip breaker
// cũ → MỖI LLM call đốt 3 model × 240s = 12 phút chết trước khi chạm model
// cuối. Theo dõi timeout LIÊN TIẾP theo model:
//   - ≥ MODEL_TIMEOUT_STRIKES lần timeout liên tiếp (qua nhiều call) → block
//     model theo MODEL_BLOCK_BREAKER_MS (fail-fast sang model kế trong chuỗi)
//   - 1 lần SUCCESS → reset strikes (model hồi phục)
// Phanh an toàn: breaker tự hết sau 10' (isModelHardBlocked expire) — nếu
// vendor hồi thì model quay lại vòng xoay ngay, không cần restart app.
const MODEL_TIMEOUT_STRIKES = Math.max(1, parseInt(process.env.MODEL_TIMEOUT_STRIKES || '2', 10) || 2)

/** FIX (R2-a #2): timeout hiệu dụng co giãn theo maxTokens — 2 lần sinh output
 * dài hợp lệ (32k token ở 60-150 tok/s cần 3.5-9 phút) không được phép đếm
 * strike đánh sập model healthy. base + maxTokens × 12ms/token (env
 * LLM_TIMEOUT_MS_PER_TOKEN). 8k → 150s (base) · 16k → 192s · 32k → 384s. */
const LLM_TIMEOUT_MS_PER_TOKEN = Math.max(1, parseInt(process.env.LLM_TIMEOUT_MS_PER_TOKEN || '12', 10) || 12)
function scaleTimeoutByMaxTokens(baseMs: number, maxTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return baseMs
  return Math.max(baseMs, Math.ceil(maxTokens * LLM_TIMEOUT_MS_PER_TOKEN))
}

const modelTimeoutStrikes = gLlmBreakerState.__tmoModelTimeoutStrikes ?? (gLlmBreakerState.__tmoModelTimeoutStrikes = new Map<string, number>())
/** FIX (breaker-audit #4): timestamp strike gần nhất — strike chỉ còn giá trị
 *  trong MODEL_TIMEOUT_STRIKE_WINDOW_MS (30'). Trước đây 2 timeout cách nhau
 *  nhiều giờ/ngày vẫn cộng dồn thành "liên tiếp" → trip oan model đã hồi. */
const modelTimeoutLastAt = gLlmBreakerState.__tmoModelTimeoutLastAt ?? (gLlmBreakerState.__tmoModelTimeoutLastAt = new Map<string, number>())
const MODEL_TIMEOUT_STRIKE_WINDOW_MS = Math.max(60_000, parseInt(process.env.MODEL_TIMEOUT_STRIKE_WINDOW_MS || '1800000', 10) || 1_800_000) // 30 phút

/** Gọi SAU MỖI attempt — phân loại theo status của attemptNvidiaOnce. */
function noteModelAttempt(model: string, status: string): void {
  if (status === 'timeout') {
    const lastAt = modelTimeoutLastAt.get(model) ?? 0
    if (lastAt && Date.now() - lastAt > MODEL_TIMEOUT_STRIKE_WINDOW_MS) {
      // Strike cũ đã ngoài cửa sổ 30' — không còn "liên tiếp", tính lại từ 1
      modelTimeoutStrikes.delete(model)
      console.warn(`[LLM] ⏱ TIMEOUT-STRIKE window reset: strike cũ của ${model} đã ${Math.round((Date.now() - lastAt) / 60000)}' phút cũ — tính lại từ 1`)
    }
    modelTimeoutLastAt.set(model, Date.now())
    const strikes = (modelTimeoutStrikes.get(model) ?? 0) + 1
    modelTimeoutStrikes.set(model, strikes)
    console.warn(`[LLM] ⏱ TIMEOUT-STRIKE ${strikes}/${MODEL_TIMEOUT_STRIKES}: model ${model} hang (0 bytes) — ${strikes >= MODEL_TIMEOUT_STRIKES ? 'TRIP breaker, fail-fast sang model kế' : 'còn theo dõi'}`)
    if (strikes >= MODEL_TIMEOUT_STRIKES) {
      tripModelBreaker(
        model,
        `TIMEOUT-BREAKER (Task 22): ${strikes} lần timeout trong cửa sổ ${Math.round(MODEL_TIMEOUT_STRIKE_WINDOW_MS / 60000)} phút — model HANG phía NVIDIA NIM (server nhận request nhưng 0 bytes trả về; các model khác vẫn chạy bình thường = sự cố model-level, không phải key/network). Đã block ${Math.round(MODEL_BLOCK_BREAKER_MS / 60000)} phút để fail-fast sang model kế; model tự quay lại sau khi hết block hoặc app restart.`,
        'timeout-hang',
      )
      modelTimeoutStrikes.delete(model)
      modelTimeoutLastAt.delete(model)
    }
  } else if (status === 'success') {
    // Model hồi phục → xóa strikes
    modelTimeoutStrikes.delete(model)
    modelTimeoutLastAt.delete(model)
  }
}

/** Diagnostic — trạng thái breaker hiện tại (cho API/status hiển thị) */
export function getModelBlockBreakers(): Array<{ model: string; blockedUntil: number; reason: string }> {
  const now = Date.now()
  return [...modelBlockBreakers.entries()]
    .filter(([, b]) => b.blockedUntil > now)
    .map(([model, b]) => ({ model, blockedUntil: b.blockedUntil, reason: b.reason }))
}

// ==================== MODEL HEALTH PROBER (Task 20 — 2026-09-03) ====================
// Root-cause "chờ một lúc rồi Agents không tạo được output do LLM call thất bại"
// (user report 2026-09-03): khi các lõi đầu chuỗi HANG phía NIM (0 bytes — sự cố
// model-level đã verify live: kimi-k3/v4-pro/v4-flash timeout trên mọi key,
// minimax-m3 200OK trên cùng key), chuỗi MODEL-FIRST phải đốt 3 × timeout
// (~450s) trước khi tới lượt minimax-m3 — nhưng CALLER giết chuỗi bằng timeout
// ngoài SỚM HƠN (self-direction 120s, alista 60s, checkpoint-verify 30s, omega
// consult 180s...) → minimax KHÔNG BAO GIỜ được gọi dù vẫn khỏe.
//
// Prober (nhánh 1 của Task 20): probe nền định kỳ 6 lõi (chuỗi agent 4 + lõi
// extraction 2) bằng request nhỏ 16 token, mỗi lõi 1 key khác nhau (phân tải
// RPM). Timeout 0-byte trên request nhỏ = bằng chứng hang unambiguous → TRIP
// breaker NGAY (không chờ 2 strike như call thật) — call thật sau đó skip model
// hang trong ~ms và nhảy thẳng tới lõi khỏe (minimax trả lời ~1.5s). Probe
// THÀNH CÔNG → xóa breaker + strikes ngay (model hồi phục nhanh, không đợi
// hết 10' window). 429/5xx/auth/quota trên probe = transient/key-level → KHÔNG
// kết luận gì về model.
//
// Nhánh 2: caller outer-timeout nâng ≥ worst-case chuỗi (600s, env-overridable)
// — xem orchestrator/scan/alista/omega/workflow-engine. Transition window
// (~2 phút sau boot, trước probe đầu) chuỗi vẫn được phép chạy đủ 3×timeout
// để tới minimax thay vì bị caller giết giữa chừng.
//
// Env: LLM_MODEL_PROBER (default on) · LLM_PROBE_INTERVAL_MS (300000) ·
//      LLM_PROBE_TIMEOUT_MS (90000 — dư dả cho reasoning model khỏe; model
//      cần >90s cho câu trả lời 16 token là model chậm, block 10' là đúng
//      chính sách latency-first) · LLM_PROBER_BOOT_DELAY_MS (30000).
// Fail-open tuyệt đối; timer unref'd (không giữ process); globalThis guard
// chống double-register khi Next dev HMR reload.

const PROBER_ENABLED = (process.env.LLM_MODEL_PROBER ?? '1').trim().toLowerCase() !== 'false'
const PROBE_INTERVAL_MS = Math.max(60_000, parseInt(process.env.LLM_PROBE_INTERVAL_MS || '300000', 10) || 300_000)
const PROBE_TIMEOUT_MS = Math.max(10_000, parseInt(process.env.LLM_PROBE_TIMEOUT_MS || '90000', 10) || 90_000)
const PROBER_BOOT_DELAY_MS = Math.max(0, parseInt(process.env.LLM_PROBER_BOOT_DELAY_MS || '30000', 10) || 30_000)

/** 6 lõi được probe: lõi chính + chuỗi fallback (agent) + 2 lõi extraction */
function probeTargets(): string[] {
  const targets = [
    KIMI_K3_MODEL,
    ...AGENT_FALLBACK_CHAIN,
    EXTRACTION_MODEL_OVERRIDE || NVIDIA_EXTRACTION_MODELS[0],
    NVIDIA_EXTRACTION_MODELS[1],
  ]
  return [...new Set(targets)]
}

/** Probe 1 model bằng request nhỏ. Trả về 'ok' | 'hang' | 'skip' (transient). */
async function probeModelOnce(model: string, slot: number): Promise<'ok' | 'hang' | 'skip'> {
  const pool = nvidiaPool
  // Key theo slot (0..3) — getKeyByIndex tự fallback sang key khả dụng kế
  // khi slot rỗng/rate-limited; hết key → skip cycle này (fail-open).
  const keyInfo = pool.getKeyByIndex(slot % MAX_KEYS)
  if (!keyInfo || !keyInfo.key) return 'skip'
  const startedAt = Date.now()
  let attempt: Awaited<ReturnType<typeof attemptNvidiaOnce>>
  try {
    attempt = await attemptNvidiaOnce({
      keyInfo: { key: keyInfo.key, keyIndex: keyInfo.keyIndex },
      model,
      prompt: 'Health probe — reply with exactly: OK',
      systemPrompt: undefined,
      temperature: 0,
      maxTokens: 16,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
  } catch {
    return 'skip' // network throw ngoài dự kiến — không kết luận model
  }
  const ms = Date.now() - startedAt
  if (attempt.status === 'success') {
    // Model khỏe / đã hồi phục → xóa breaker + strikes NGAY (không đợi 10')
    const hadBreaker = modelBlockBreakers.has(model)
    modelBlockBreakers.delete(model)
    modelTimeoutStrikes.delete(model)
    modelTimeoutLastAt.delete(model)
    if (hadBreaker) {
      console.log(`[LLM-Prober] 🟢 ${model} ĐÃ HỒI PHỤC (probe ✓ ${ms}ms) — xóa circuit breaker, call thật trở lại model này`)
    }
    return 'ok'
  }
  if (attempt.status === 'timeout') {
    // 0-byte trên request nhỏ 16 token = hang unambiguous → trip breaker NGAY
    // (call thật skip model này trong ~ms; probe kế (5') sẽ tự mở lại nếu hồi)
    tripModelBreaker(
      model,
      `PROBE HANG: request nhỏ (16 token) chờ ${Math.round(PROBE_TIMEOUT_MS / 1000)}s vẫn 0 bytes — model HANG phía NVIDIA NIM (model khác cùng key vẫn chạy = sự cố model-level, không phải key/network). Prober sẽ tự mở lại khi model hồi phục (probe mỗi ${Math.round(PROBE_INTERVAL_MS / 60000)} phút).`,
      'timeout-hang',
    )
    return 'hang'
  }
  // 429/5xx/auth/daily-quota/bad_request/empty — transient hoặc key-level,
  // không đủ bằng chứng kết luận model. Log 1 dòng để theo dõi.
  console.log(`[LLM-Prober] ⚪ ${model} → ${attempt.status} (transient/key — không trip)`)
  return 'skip'
}

let probeCycleRunning = false

/** 1 chu kỳ probe: tất cả lõi song song (mỗi lõi 1 key). */
async function runProbeCycle(): Promise<void> {
  if (probeCycleRunning) return
  probeCycleRunning = true
  try {
    const targets = probeTargets()
    const results = await Promise.all(targets.map((m, i) => probeModelOnce(m, i)))
    const ok = results.filter(r => r === 'ok').length
    const hang = results.filter(r => r === 'hang').length
    const skip = results.filter(r => r === 'skip').length
    console.log(`[LLM-Prober] chu kỳ xong: ${ok} ok · ${hang} hang (đã trip breaker) · ${skip} skip — chuỗi agent sẽ đi thẳng lõi khỏe`)
  } catch (err) {
    console.warn('[LLM-Prober] chu kỳ lỗi (fail-open):', err instanceof Error ? err.message : String(err))
  } finally {
    probeCycleRunning = false
  }
}

/** Khởi động prober (gọi 1 lần từ instrumentation-node lúc boot). Idempotent. */
export function startModelHealthProber(): void {
  const globalForProber = globalThis as unknown as { __tmoLlmProberStarted?: boolean }
  if (globalForProber.__tmoLlmProberStarted) return
  globalForProber.__tmoLlmProberStarted = true
  if (!PROBER_ENABLED) {
    console.log('[LLM-Prober] TẮT (LLM_MODEL_PROBER=false) — call thật tự dò strike/breaker như cũ')
    return
  }
  if (nvidiaPool.keyCount === 0) {
    console.log('[LLM-Prober] không có NVIDIA key nào (NVIDIA_API_KEY_1..4) — bỏ prober')
    return
  }
  const bootTimer = setTimeout(() => {
    void runProbeCycle() // probe đầu tiên: dò luôn trạng thái NIM sau boot
    const interval = setInterval(() => { void runProbeCycle() }, PROBE_INTERVAL_MS)
    interval.unref?.()
  }, PROBER_BOOT_DELAY_MS)
  bootTimer.unref?.()
  console.log(`[LLM-Prober] khởi động: probe ${probeTargets().length} lõi mỗi ${Math.round(PROBE_INTERVAL_MS / 60000)} phút (timeout ${Math.round(PROBE_TIMEOUT_MS / 1000)}s/lõi, bắt đầu sau ${Math.round(PROBER_BOOT_DELAY_MS / 1000)}s)`)
}

async function callModelWithKeyRotation(
  model: string,
  prompt: string,
  systemPrompt: string | undefined,
  options?: LLMCallOptions,
  rotationOpts?: { startKeyIndex?: number; timeoutMs?: number; maxTokens?: number; temperature?: number; taskLabel?: string },
): Promise<LLMResult | null> {
  // ===== CIRCUIT BREAKER — hard-block đã được xác nhận trước đó → fail NGAY =====
  const breaker = isModelHardBlocked(model)
  if (breaker.blocked) {
    console.warn(`[LLM] 🔴 ${model} (${rotationOpts?.taskLabel || 'rotation'}): circuit breaker đang mở — bỏ qua xoay vòng (còn ${Math.ceil((modelBlockBreakers.get(model)!.blockedUntil - Date.now()) / 1000)}s). ${breaker.reason}`)
    return null
  }

  const pool = nvidiaPool
  const validIndices: number[] = []
  for (let i = 0; i < MAX_KEYS; i++) {
    if (pool.getRawKeyInfo(i)) validIndices.push(i)
  }
  if (validIndices.length === 0) {
    console.warn(`[LLM] 🔄 ${model}: KHÔNG có NVIDIA key nào hợp lệ (NVIDIA_API_KEY_1..4)`)
    return null
  }

  // ===== Hard-block detection state =====
  /** Số lần cooldown đã reset xong (key "recovered" theo thời gian) rồi retry */
  let cooldownCycles = 0
  /** Các key trả 429-instant KỂ TỪ cooldown gần nhất (reset khi có kết quả khác) */
  const instant429Keys = new Set<number>()

  const taskLabel = rotationOpts?.taskLabel || 'rotation'
  const maxTokens = rotationOpts?.maxTokens ?? options?.maxTokens ?? 4096
  // FIX (R2-a #2): timeout co giãn theo maxTokens — chống breaker đánh sập
  // model healthy khi sinh output dài hợp lệ.
  const timeoutMs = scaleTimeoutByMaxTokens(
    rotationOpts?.timeoutMs ?? parseInt(process.env.LLM_TIMEOUT_MS || '240000', 10),
    maxTokens,
  )
  const temperature = rotationOpts?.temperature ?? options?.temperature ?? 0.1

  // Chuỗi attempt: xoay vòng validIndices đủ KEY_FAILURES_PER_KEY vòng —
  // mỗi key đúng 3 lần, quay vòng hết 4 key lại về key đầu tiên (user directive).
  const startIndex = rotationOpts?.startKeyIndex != null && rotationOpts.startKeyIndex >= 0
    ? validIndices.indexOf(rotationOpts.startKeyIndex) >= 0
      ? validIndices.indexOf(rotationOpts.startKeyIndex)
      : 0
    : (kimiKeyRotationCounter++) % validIndices.length
  const maxAttempts = validIndices.length * KEY_FAILURES_PER_KEY

  const failuresByKey = new Map<number, number>()
  const deadKeys = new Set<number>()   // daily-quota / auth-dead trong chuỗi này
  const startedAt = Date.now()
  let attemptNo = 0

  console.log(`[LLM] 🔄 ${model} (${taskLabel}): bắt đầu xoay vòng ${validIndices.length} key × ${KEY_FAILURES_PER_KEY} lần = tối đa ${maxAttempts} attempts`)

  for (let round = 0; round < KEY_FAILURES_PER_KEY; round++) {
    for (let offset = 0; offset < validIndices.length; offset++) {
      // Abort check — người dùng bấm Dừng → cắt ngang chuỗi ngay
      if (options?.abortCheck && options.abortCheck()) {
        console.log(`[LLM] 🔄 ${model}: chuỗi xoay vòng bị HỦY (abortCheck) sau ${attemptNo} attempts`)
        return null
      }
      // Budget — chặn trường hợp mọi attempt đều treo timeout
      if (Date.now() - startedAt > KEY_ROTATION_BUDGET_MS) {
        console.warn(`[LLM] 🔄 ${model}: vượt budget ${KEY_ROTATION_BUDGET_MS / 60000} phút sau ${attemptNo} attempts — dừng xoay vòng`)
        return null
      }

      const keyIdx = validIndices[(startIndex + round * validIndices.length + offset) % validIndices.length]
      if (deadKeys.has(keyIdx)) continue
      const keyInfo = pool.getRawKeyInfo(keyIdx)
      if (!keyInfo) continue

      // FIX (R2-a #3): breaker có thể TRIP giữa chừng chuỗi (2 timeout strike
      // từ call khác/cùng call) — check TRƯỚC MỖI attempt thay vì chỉ ở cửa vào,
      // ngừng đốt key/time budget cho model đã bị chặn.
      if (isModelHardBlocked(model).blocked) {
        console.warn(`[LLM] 🔄 ${model} (${taskLabel}): breaker TRIPPED giữa xoay vòng sau ${attemptNo} attempts — dừng NGAY (fail-fast)`)
        return null
      }

      attemptNo++

      const attemptStartedAt = Date.now()
      const attempt = await attemptNvidiaOnce({
        keyInfo,
        model,
        prompt,
        systemPrompt,
        temperature,
        maxTokens,
        timeoutMs,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        agentId: options?.agentId,
        agentName: options?.agentName,
      })
      const attemptMs = Date.now() - attemptStartedAt
      // TASK 22 — model timeout health (fast-fail khi model HANG)
      noteModelAttempt(model, attempt.status)

      if (attempt.status === 'success' && attempt.result) {
        pool.markSuccess(keyInfo.key, attempt.result.tokensUsed)
        console.log(`[LLM] 🔄 ${model} ✓ key#${keyIdx + 1} ...${keyInfo.key.slice(-6)} (attempt ${attemptNo}, ${attempt.result.tokensUsed} tokens, ${tcCount(attempt.result)} tool_calls)`)
        return attempt.result
      }

      // ===== HARD-BLOCK DETECTION (circuit breaker input) =====
      // 429 trả về gần như NGAY LẬP TỨC (server từ chối không xử lý) = dấu hiệu
      // chặn ở tầng model/tài khoản, KHÔNG phải rate-limit RPM thông thường
      // (RPM-throttle thường trả 429 sau khi đã xử lý 1 phần hoặc kèm Retry-After).
      const isInstant429 = attempt.status === 'rate_limited' && attemptMs < INSTANT_429_MS
      if (isInstant429) {
        instant429Keys.add(keyIdx)
      } else {
        // Kết quả khác (thành công/timeout/5xx/429 chậm) → sweep này không phải hard-block
        instant429Keys.clear()
      }
      // Đã từng cooldown-reset xong mà sweep hiện tại lại TOÀN 429-instant trên
      // mọi key → chặn cứng đã được xác nhận → trip breaker, fail NGAY (không
      // đốt thêm 15' budget). Cooldown RPM thật đã có 30s để hồi — nếu 30s sau
      // vẫn instant-429 toàn bộ thì không phải RPM.
      // FIX (breaker-audit #2): ngưỡng "mọi key" phải theo key CÒN SỐNG — key
      // daily-quota/auth-dead đã bị loại khỏi vòng (deadKeys) nên không bao giờ
      // vào instant429Keys; so với validIndices.length khiến breaker KHÔNG BAO
      // GIỜ trip được khi ≥1 key chết (đúng lúc tối cần fail-fast: cạn quota).
      const aliveKeyCount = validIndices.length - deadKeys.size
      if (cooldownCycles >= 1 && aliveKeyCount > 0 && instant429Keys.size >= aliveKeyCount) {
        tripModelBreaker(
          model,
          `Xác nhận bằng live-test: cả ${validIndices.length} key đều 429-instant (${attemptMs}ms/lần) ngay cả sau cooldown ${cooldownCycles} lần — khả năng NVIDIA NIM chặn model ở tầng tài khoản/hạn mức. Kiểm tra tài khoản NIM (build.nvidia.com → Credits/Rate limits) hoặc thử model khác trên cùng key để xác nhận.`,
        )
        return null
      }

      const failCount = (failuresByKey.get(keyIdx) || 0) + 1
      failuresByKey.set(keyIdx, failCount)

      if (attempt.status === 'bad_request') {
        // FIX (R2-a #7): 400/413/422 deterministic — body hỏng thì retry key khác
        // CÙNG body cũng fail y hệt → dừng NGAY, không đốt 11 attempts còn lại.
        console.warn(`[LLM] 🔄 ${model} ✗ key#${keyIdx + 1} → bad_request (HTTP ${attempt.httpStatus}) — LỖI BODY deterministic, dừng xoay vòng: ${attempt.errorMessage?.slice(0, 160)}`)
        return null
      }
      if (attempt.status === 'daily_quota') {
        // Key chết tới nửa đêm — loại khỏi chuỗi (không thử tiếp 2 lần còn lại)
        pool.markDailyQuotaExhausted(keyInfo.key)
        deadKeys.add(keyIdx)
        console.warn(`[LLM] 🔄 ${model} ✗ key#${keyIdx + 1} → 429 DAILY QUOTA — loại key khỏi chuỗi (reset nửa đêm)`)
      } else if (attempt.status === 'auth_error') {
        // Key sai/hết hạn — thử lại vô nghĩa, loại luôn (đã tiêu 1/3 lần fail)
        pool.markRateLimitedSoft(keyInfo.key, 60000)
        deadKeys.add(keyIdx)
        console.warn(`[LLM] 🔄 ${model} ✗ key#${keyIdx + 1} → ${attempt.errorMessage} (auth) — loại key khỏi chuỗi`)
      } else {
        // 429 RPM / 5xx / timeout / network / empty — cooldown ngắn cho pool,
        // KHÔNG tăng failureCount pool (tránh cascade-exhaust) rồi CHUYỂN KEY
        pool.markRateLimitedSoft(keyInfo.key, attempt.status === 'rate_limited' ? 30000 : 15000)
        console.log(`[LLM] 🔄 ${model} ✗ key#${keyIdx + 1} ...${keyInfo.key.slice(-6)} → ${attempt.status}${attempt.httpStatus ? ` (${attempt.httpStatus})` : ''} [fail ${failCount}/${KEY_FAILURES_PER_KEY}]${attempt.errorMessage ? ` — ${attempt.errorMessage.slice(0, 120)}` : ''} → chuyển key kế tiếp`)
      }

      if (failCount >= KEY_FAILURES_PER_KEY) {
        deadKeys.add(keyIdx)
      }
      if (deadKeys.size >= validIndices.length) {
        // RATE-LIMIT WAIT: If all keys are dead due to RATE-LIMITING (not daily-quota/auth),
        // WAIT for the earliest cooldown reset instead of immediately giving up.
        // This is the critical fix for "agents stop mid-task after a few iterations" —
        // the 429 rate limit (30-45s cooldown) was causing immediate failure instead of
        // waiting for a key to become available again.
        const waited = await waitForRateLimitCooldown(pool, options?.abortCheck)
        if (waited.recovered) {
          // A key became available — reset deadKeys and RESTART all rounds.
          // (fix 2026-08-27: trước đây chỉ `continue` inner-loop — nếu wait rơi vào
          // iteration cuối của round cuối thì vòng lặp kết thúc, key đã recovered
          // không bao giờ được thử lại.) Budget 15 phút vẫn chặn tổng thời gian.
          console.log(`[LLM] 🔄 ${model}: rate-limit cooldown expired — retrying with refreshed keys`)
          deadKeys.clear()
          for (const [k] of failuresByKey) failuresByKey.set(k, 0)
          // FIX (breaker-audit #1): chỉ đếm cooldown-cycle THẬT (đã ngủ ≥30s
          // qua reset) — vacuous cycle (reset-time cũ → trả ngay, 0s) không
          // đủ bằng chứng "đã qua cooldown mà vẫn 429" để arming breaker.
          if (waited.waitedMs >= REAL_COOLDOWN_CYCLE_MIN_MS) cooldownCycles++
          instant429Keys.clear() // sweep mới bắt đầu — đếm lại 429-instant
          round = -1 // restart outer round loop
          break      // exit inner offset loop
        }
        console.warn(`[LLM] 🔄 ${model}: MỌI key đều đã fail đủ ${KEY_FAILURES_PER_KEY} lần (sau ${attemptNo} attempts) — dừng xoay vòng`)
        return null
      }
    }
  }

  console.warn(`[LLM] 🔄 ${model}: hết chuỗi xoay vòng (${attemptNo} attempts) — mọi key đều fail đủ ${KEY_FAILURES_PER_KEY} lần`)
  return null
}

/** Counter xoay vòng start key cho agent/chat calls — phân tải đều các key */
let kimiKeyRotationCounter = 0

function tcCount(result: LLMResult): number {
  return result.tool_calls?.length ?? 0
}

// ==================== MODEL-FIRST CHAIN — KEY SAU CÙNG (USER DIRECTIVE 2026-09-06) ====================

/**
 * USER DIRECTIVE 2026-09-06 — MODEL TRƯỚC, KEY SAU:
 *   "đối với tác vụ trích xuất, tôi muốn gọi nemotron-3-ultra-550b không được
 *    thì chuyển qua gọi gpt-oss-120b luôn, nếu gpt-oss-120b cũng lỗi thì mới
 *    chuyển key; tương tự với Agent/Chat: gọi lõi chính không được thì lần lượt
 *    chuyển qua các lõi fallback luôn, chuyển tới lõi cuối mới chuyển key"
 *
 * Nghĩa vụ thi hành:
 *   • Trên CÙNG 1 key, chạy ĐẦY ĐỦ chuỗi model theo thứ tự cố định
 *     (lõi chính → fallback 1 → ... → fallback cuối), mỗi model 1 attempt.
 *   • Model fail → chuyển NGAY model kế tiếp (KHÔNG chuyển key).
 *   • Key chết vĩnh viễn (429 daily-quota / 401 auth) → chuyển key NGAY
 *     (key chết thì model kế trên key đó cũng vô nghĩa).
 *   • CẢ chuỗi model fail trên key → CHUYỂN KEY, chain khởi động lại từ lõi chính.
 *   • Hết mọi key → chờ rate-limit cooldown (nếu tạm thời) rồi sweep lại.
 *     Tổng số sweep = KEY_FAILURES_PER_KEY (3) — mỗi model cuối cùng được thử
 *     đúng 3 lần/key (1 lần/sweep), bảo toàn tổng retry volume của chính sách
 *     key-first cũ nhưng ĐẢO ngược thứ tự ưu tiên theo directive mới.
 *
 * Circuit breaker (hard-block 429): model 429-instant trên MỌI key trong 1 sweep
 * SAU ít nhất 1 cooldown cycle → trip breaker, skip model đó ở sweep sau.
 *
 * Giữ nguyên: budget KEY_ROTATION_BUDGET_MS, abortCheck, token tracking,
 * native tool-calls, daily-quota/auth-dead key isolation.
 */
async function callModelChainModelFirst(
  modelChain: string[],
  prompt: string,
  systemPrompt: string | undefined,
  options?: LLMCallOptions,
  chainOpts?: { startKeyIndex?: number; timeoutMs?: number; maxTokens?: number; temperature?: number; taskLabel?: string },
): Promise<LLMResult | null> {
  const taskLabel = chainOpts?.taskLabel || 'chain'
  const pool = nvidiaPool

  // Circuit breaker đang mở → bỏ model khỏi chuỗi (fail-fast)
  const activeChain: string[] = []
  for (const m of modelChain) {
    const breaker = isModelHardBlocked(m)
    if (breaker.blocked) {
      console.warn(`[LLM] 🔗 ${taskLabel}: model ${m} bị circuit breaker chặn — bỏ qua (còn ${Math.ceil((modelBlockBreakers.get(m)!.blockedUntil - Date.now()) / 1000)}s)`)
      continue
    }
    activeChain.push(m)
  }
  if (activeChain.length === 0) {
    console.warn(`[LLM] 🔗 ${taskLabel}: TẤT CẢ model trong chuỗi [${modelChain.join(' → ')}] đều bị circuit breaker chặn — fail-fast`)
    return null
  }

  const validIndices: number[] = []
  for (let i = 0; i < MAX_KEYS; i++) {
    if (pool.getRawKeyInfo(i)) validIndices.push(i)
  }
  if (validIndices.length === 0) {
    console.warn(`[LLM] 🔗 ${taskLabel}: KHÔNG có NVIDIA key nào hợp lệ (NVIDIA_API_KEY_1..4)`)
    return null
  }

  const maxTokens = chainOpts?.maxTokens ?? options?.maxTokens ?? 4096
  // FIX (R2-a #2): timeout co giãn theo maxTokens (mirror callModelWithKeyRotation)
  const timeoutMs = scaleTimeoutByMaxTokens(
    chainOpts?.timeoutMs ?? parseInt(process.env.LLM_TIMEOUT_MS || '240000', 10),
    maxTokens,
  )
  const temperature = chainOpts?.temperature ?? options?.temperature ?? 0.1

  // Key bắt đầu: key được gán (extraction) hoặc xoay counter toàn cục (agent/chat)
  const startIndex = chainOpts?.startKeyIndex != null && chainOpts.startKeyIndex >= 0
    ? Math.max(0, validIndices.indexOf(chainOpts.startKeyIndex))
    : (kimiKeyRotationCounter++) % validIndices.length

  const deadKeys = new Set<number>() // daily-quota / auth-dead trong CALL này
  // FIX (breaker-audit #3): bad_request là deterministic THEO BODY — model đã
  // trả 400/413/422/431 thì key khác retry cùng body cũng fail y hệt. Comment
  // R2-a #7 vốn hứa "KHÔNG retry model này trên key khác" nhưng code cũ chỉ
  // break vòng model → key kế vẫn chạy chuỗi lại từ đầu → đốt 4 key × 3 sweep
  // attempt 400 vô nghĩa.
  const badRequestModels = new Set<string>()
  const startedAt = Date.now()
  let attemptNo = 0
  let cooldownCycles = 0
  let sweepNo = 0

  // NOTE: không bracket trước tên model (dev.log strip ANSI ăn "[m") — xem ghi chú banner phía trên.
  console.log(`[LLM] 🔗 ${taskLabel}: MODEL-FIRST: ${activeChain.join(' → ')} × ${validIndices.length} key — model fallback trước, chỉ chuyển key khi cả chuỗi fail (tối đa ${KEY_FAILURES_PER_KEY} sweep)`)

  while (sweepNo < KEY_FAILURES_PER_KEY) {
    sweepNo++
    // Instant-429 + tập key THỰC SỰ THỬ per model trong sweep này (input circuit breaker)
    // FIX (breaker-audit #2): ngưỡng trip so với attempted thay vì
    // validIndices.length — key bị skip (dead/quota/break chuỗi sớm) không khiến
    // phép so trở nên bất khả thi (kẹt vĩnh viễn không trip được).
    const sweepInstant429 = new Map<string, Set<number>>()
    const sweepAttemptedKeys = new Map<string, Set<number>>()
    for (const m of activeChain) {
      sweepInstant429.set(m, new Set())
      sweepAttemptedKeys.set(m, new Set())
    }

    for (let offset = 0; offset < validIndices.length; offset++) {
      const keyIdx = validIndices[(startIndex + offset) % validIndices.length]
      if (deadKeys.has(keyIdx)) continue
      const keyInfo = pool.getRawKeyInfo(keyIdx)
      if (!keyInfo) continue
      // Key đã daily-quota-dead từ call khác → skip (không đốt attempt)
      if (keyInfo.dailyQuotaExhausted && Date.now() < keyInfo.dailyQuotaResetAt) {
        deadKeys.add(keyIdx)
        console.warn(`[LLM] 🔗 ${taskLabel}: key#${keyIdx + 1} daily-quota-dead (từ call khác) — bỏ qua key`)
        continue
      }

      let chainFailedOnKey = false
      for (const model of activeChain) {
        // Model có thể bị trip breaker giữa sweep → bỏ qua
        if (isModelHardBlocked(model).blocked) continue
        // FIX (breaker-audit #3): model đã bad_request ở key trước trong call
        // này → deterministic theo body, key khác cũng fail y hệt → bỏ qua
        if (badRequestModels.has(model)) continue
        // Người dùng bấm Dừng → cắt ngang chuỗi ngay
        if (options?.abortCheck && options.abortCheck()) {
          console.log(`[LLM] 🔗 ${taskLabel}: chuỗi bị HỦY (abortCheck) sau ${attemptNo} attempts`)
          return null
        }
        // Budget — chặn trường hợp mọi attempt đều treo timeout
        if (Date.now() - startedAt > KEY_ROTATION_BUDGET_MS) {
          console.warn(`[LLM] 🔗 ${taskLabel}: vượt budget ${KEY_ROTATION_BUDGET_MS / 60000} phút sau ${attemptNo} attempts — dừng chuỗi`)
          return null
        }

        attemptNo++
        sweepAttemptedKeys.get(model)!.add(keyIdx)
        const attemptStartedAt = Date.now()
        const attempt = await attemptNvidiaOnce({
          keyInfo: { key: keyInfo.key, keyIndex: keyIdx },
          model,
          prompt,
          systemPrompt,
          temperature,
          maxTokens,
          timeoutMs,
          tools: options?.tools,
          tool_choice: options?.tool_choice,
          agentId: options?.agentId,
          agentName: options?.agentName,
        })
        const attemptMs = Date.now() - attemptStartedAt
        // TASK 22 — model timeout health (fast-fail khi model HANG)
        noteModelAttempt(model, attempt.status)

        if (attempt.status === 'success' && attempt.result) {
          pool.markSuccess(keyInfo.key, attempt.result.tokensUsed)
          console.log(`[LLM] 🔗 ${taskLabel} ✓ ${model} key#${keyIdx + 1} ...${keyInfo.key.slice(-6)} (attempt ${attemptNo}, ${attempt.result.tokensUsed} tokens, ${tcCount(attempt.result)} tool_calls)`)
          return attempt.result
        }

        // ===== HARD-BLOCK DETECTION per model =====
        // 429 trả về gần như NGAY LẬP TỨC = dấu hiệu chặn ở tầng model/tài khoản,
        // không phải rate-limit RPM thông thường.
        if (attempt.status === 'rate_limited' && attemptMs < INSTANT_429_MS) {
          sweepInstant429.get(model)!.add(keyIdx)
        }

        if (attempt.status === 'daily_quota') {
          // Key chết tới nửa đêm — model kế trên key này vô nghĩa → chuyển key
          pool.markDailyQuotaExhausted(keyInfo.key)
          deadKeys.add(keyIdx)
          console.warn(`[LLM] 🔗 ${taskLabel} ✗ ${model} key#${keyIdx + 1} ...${keyInfo.key.slice(-6)} → 429 DAILY QUOTA — key chết tới nửa đêm, chuyển KEY`)
          chainFailedOnKey = true
          break
        }
        if (attempt.status === 'auth_error') {
          // Key sai/hết hạn — thử lại vô nghĩa → chuyển key
          pool.markRateLimitedSoft(keyInfo.key, 60000)
          deadKeys.add(keyIdx)
          console.warn(`[LLM] 🔗 ${taskLabel} ✗ ${model} key#${keyIdx + 1} ...${keyInfo.key.slice(-6)} → ${attempt.errorMessage} (auth) — loại key, chuyển KEY`)
          chainFailedOnKey = true
          break
        }

        // FIX (R2-a #7): bad_request deterministic → KHÔNG soft-mark cooldown key
        // (lỗi body, không phải lỗi key) — chỉ chuyển MODEL kế (model khác có thể
        // nhận context dài hơn → đáng thử), KHÔNG retry model này trên key khác.
        if (attempt.status === 'bad_request') {
          badRequestModels.add(model)
          console.warn(`[LLM] 🔗 ${taskLabel} ✗ ${model} key#${keyIdx + 1} → bad_request (HTTP ${attempt.httpStatus}) — body deterministic, model này không được retry trên key khác: ${attempt.errorMessage?.slice(0, 160)}`)
          chainFailedOnKey = true
          break
        }
        // 429 RPM / 5xx / timeout / network / empty → DIRECTIVE 2026-09-06:
        // chuyển MODEL kế tiếp trên CÙNG key (soft-mark, không tăng failureCount)
        pool.markRateLimitedSoft(keyInfo.key, attempt.status === 'rate_limited' ? 30000 : 15000)
        console.log(`[LLM] 🔗 ${taskLabel} ✗ ${model} key#${keyIdx + 1} ...${keyInfo.key.slice(-6)} → ${attempt.status}${attempt.httpStatus ? ` (${attempt.httpStatus})` : ''}${attempt.errorMessage ? ` — ${attempt.errorMessage.slice(0, 120)}` : ''} → chuyển MODEL kế (cùng key)`)
        chainFailedOnKey = true
      }

      // CẢ chuỗi model fail trên key này → "mới chuyển key" (directive 2026-09-06)
      if (chainFailedOnKey && !deadKeys.has(keyIdx)) {
        console.warn(`[LLM] 🔗 ${taskLabel}: CẢ chuỗi [${activeChain.join(' → ')}] fail trên key#${keyIdx + 1} — CHUYỂN KEY`)
      }
    }

    // ===== Sau sweep: trip breaker cho model bị hard-block xác nhận =====
    // (đã qua ít nhất 1 cooldown cycle mà vẫn 429-instant trên MỌI key)
    if (cooldownCycles >= 1) {
      for (const model of activeChain) {
        const instant429Count = sweepInstant429.get(model)!.size
        const attemptedCount = sweepAttemptedKeys.get(model)!.size
        // FIX (breaker-audit #2): mọi key ĐÃ THỬ model này đều 429-instant
        // (≥2 key bằng chứng) thay vì >= validIndices.length (kẹt khi có key
        // dead/skip).
        if (attemptedCount >= 2 && instant429Count >= attemptedCount) {
          tripModelBreaker(
            model,
            `Model-first sweep xác nhận: ${model} 429-instant trên ${instant429Count}/${attemptedCount} key đã thử ngay cả sau ${cooldownCycles} lần cooldown thật — khả năng NVIDIA NIM chặn model ở tầng tài khoản/hạn mức. Kiểm tra build.nvidia.com → Credits/Rate limits.`,
          )
        }
      }
    }

    // Hết sweep cuối → dừng
    if (sweepNo >= KEY_FAILURES_PER_KEY) break

    // Còn model nào chưa bị block không?
    const stillActive = activeChain.filter(m => !isModelHardBlocked(m).blocked)
    if (stillActive.length === 0) {
      console.warn(`[LLM] 🔗 ${taskLabel}: mọi model trong chuỗi đều bị circuit breaker chặn sau sweep ${sweepNo} — dừng`)
      return null
    }

    // Hết sweep nhưng còn key/key-model khả dụng → chờ rate-limit cooldown
    // (waitForRateLimitCooldown tự trả false nếu mọi key chết vĩnh viễn)
    const waited = await waitForRateLimitCooldown(pool, options?.abortCheck)
    if (!waited.recovered) {
      console.warn(`[LLM] 🔗 ${taskLabel}: không còn key khả dụng sau sweep ${sweepNo} — dừng chuỗi (${attemptNo} attempts)`)
      return null
    }
    // FIX (breaker-audit #1): chỉ đếm cooldown-cycle THẬT (ngủ ≥30s qua reset)
    if (waited.waitedMs >= REAL_COOLDOWN_CYCLE_MIN_MS) cooldownCycles++
    console.log(`[LLM] 🔗 ${taskLabel}: key hồi sau cooldown — sweep lại (sweep ${sweepNo + 1}/${KEY_FAILURES_PER_KEY})`)
  }

  console.warn(`[LLM] 🔗 ${taskLabel}: hết ${sweepNo} sweep × (${activeChain.length} model × ${validIndices.length} key) = ${attemptNo} attempts — THẤT BẠI`)
  return null
}

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
  timeoutMs: number = parseInt(process.env.LLM_TIMEOUT_MS || '1800000', 10), // 30 min default — no aggressive timeout during extraction
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
      // tools param — verified for kimi-k3, deepseek-v4-flash, minimax-m3.
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
// (tryNvidiaSlot đã bị XÓA 2026-08-31 — callLLMSlot giờ dùng callModelChainModelFirst
//  với chính sách model-first 2026-09-06: chuỗi lõi chạy trên từng key, chuyển key sau cùng.)

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

// (EXTRACTION_MODEL_OVERRIDE khai báo ở section KIMI K3 MODEL POLICY phía trên)

/**
 * Model trích xuất FALLBACK (user directive 2026-09-05): khi lõi chính
 * (nemotron-3-ultra-550b) thất bại ĐẦY ĐỦ chuỗi xoay vòng key (4 key × 3 lần),
 * chuyển sang lõi fallback openai/gpt-oss-120b ("chatgpt-os-120b") — cũng xoay
 * vòng đủ key. Đặt EXTRACTION_FALLBACK_MODEL=none để tắt fallback.
 */
const EXTRACTION_FALLBACK_MODEL_OVERRIDE = process.env.EXTRACTION_FALLBACK_MODEL || ''

/**
 * Key-based LLM call for document processing — EXTRACTION CORES ONLY.
 *
 * NVIDIA NIM với chuỗi 2 lõi trích xuất MODEL-FIRST (user directive 2026-09-06):
 *   1. PRIMARY:   nvidia/nemotron-3-ultra-550b-a55b — gọi trước trên mỗi key
 *   2. FALLBACK:  openai/gpt-oss-120b — gọi NGAY khi primary fail (CÙNG key);
 *                 chỉ khi cả 2 lõi fail trên key đó mới chuyển key kế tiếp
 *                 (chain khởi động lại từ lõi chính trên key mới)
 *
 * KHÔNG BAO GIỜ gọi kimi-k3 (lõi agent/chat) cho extraction — đây là ràng
 * buộc cứng theo directive user. Callers không còn phải fallback sang callLLM()
 * khi không có slot: truyền slotIndex=-1 để dùng round-robin key.
 *
 * @param slotIndex - The key index (0-3) assigned to this document; -1 = round-robin
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
  const temp = options?.temperature
  const maxTok = options?.maxTokens

  // ===== Z-AI SDK PROVIDER (dựng lại 2026-09-06 — opt-in LLM_PROVIDER=zai) =====
  // Slot key NVIDIA vô nghĩa với zai — extraction defaults giữ nguyên (0.1 /
  // 16384) như chuỗi NIM phía dưới; document được gán key sẽ bỏ qua khi zai bật.
  if (isZaiProviderEnabled()) {
    const zai = await callZaiProvider(
      prompt,
      systemPrompt,
      `extraction:${taskLabel}`,
      { ...options, temperature: options?.temperature ?? 0.1, maxTokens: options?.maxTokens ?? 16384 },
      'extraction',
    )
    if (zai) return zai
  }

  // slotIndex -1 (hoặc invalid) = không có key riêng → round-robin mọi key hợp lệ.
  // (Trước đây caller phải fallback sang callLLM() khi slotIndex=-1 — callLLM()
  // giờ là kimi-k3 theo Kimi-only policy → VI PHẠM directive "extraction không
  // dùng kimi-k3". Giờ callLLMSlot tự xử lý -1 nên không còn đường rò đó.)
  if (slotIndex >= 0 && slotIndex >= MAX_KEYS) {
    console.warn(`[LLM] Invalid key index ${slotIndex} for task "${taskLabel}" — falling back to round-robin key selection`)
  }
  const startKeyIndex = slotIndex >= 0 && slotIndex < MAX_KEYS ? slotIndex : -1

  console.log(`[LLM] Key ${startKeyIndex >= 0 ? startKeyIndex : 'RR'} (NVIDIA) Task: ${taskLabel}, Prompt: ${prompt.slice(0, 80)}...`)

  // ===== MODEL-FIRST CHAIN (USER DIRECTIVE 2026-09-06) =====
  // nemotron-3-ultra-550b fail → gọi gpt-oss-120b NGAY (cùng key); cả 2 lõi
  // fail trên key đó MỚI chuyển key (chain khởi động lại từ lõi chính).
  // Key GÁN cho document được thử TRƯỚC, rồi xoay vòng các key còn lại.
  const primaryModel = EXTRACTION_MODEL_OVERRIDE || NVIDIA_EXTRACTION_MODELS[0]
  const fallbackModel =
    EXTRACTION_FALLBACK_MODEL_OVERRIDE === 'none' || EXTRACTION_FALLBACK_MODEL_OVERRIDE === ''
      ? (NVIDIA_EXTRACTION_MODELS[1] || '')
      : EXTRACTION_FALLBACK_MODEL_OVERRIDE

  const chain = fallbackModel && fallbackModel !== primaryModel
    ? [primaryModel, fallbackModel]
    : [primaryModel]

  const result = await callModelChainModelFirst(
    chain,
    prompt,
    systemPrompt,
    options,
    {
      startKeyIndex,
      taskLabel: `extraction:${taskLabel}`,
      timeoutMs: 300000, // 300s — nemotron-550b là reasoning model
      maxTokens: maxTok ?? 16384, // EXTRACTION MAX_TOKENS FIX 2026-08-27 — CoT + JSON không bị cắt
      temperature: temp ?? 0.1,
    },
  )
  if (result?.content) {
    return result
  }

  // Người dùng bấm Dừng → nhiệm vụ đã bị hủy
  if (options?.abortCheck && options.abortCheck()) {
    console.log(`[LLM] Extraction "${taskLabel}": bị HỦY (abortCheck)`)
    return {
      content: '',
      provider: 'none',
      model: 'none',
      error: `Extraction "${taskLabel}" aborted by user`,
    }
  }

  // Cả 2 lõi đều thất bại sau đủ số sweep model-first
  console.warn(`[LLM] Extraction "${taskLabel}": CẢ HAI lõi (${primaryModel}${fallbackModel ? ` + ${fallbackModel}` : ''}) đều thất bại sau ${KEY_FAILURES_PER_KEY} sweep model-first — document will be retried later`)
  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: `Extraction failed on BOTH cores (${primaryModel}${fallbackModel ? ` + fallback ${fallbackModel}` : ''}) — mọi NVIDIA key đều fail (model-first: mỗi sweep chạy đủ chuỗi lõi trên từng key, ${KEY_FAILURES_PER_KEY} sweep)`,
  }
}

// ==================== UTILITY LLM CORE (user report 2026-09-05: "kimi-k3 bị gọi ngầm khi idle") ====================

/**
 * callUtilityLLM — lõi LLM riêng cho các tác vụ NỀN / tiền xử lý / hậu xử lý:
 *   • KB writeback (writeback-extraction), auto-learn extraction
 *   • Memory extraction / summarization / merge / HOT→WARM chưng cất
 *   • Intent classification (fallback khi rule-based bó tay)
 *   • Query rewrite / HyDE / expansion
 *
 * VẤN ĐỀ GỐC (user report 2026-09-05): các tác vụ này trước đây gọi callLLM()
 * → kimi-k3 (lõi agent). Sau khi goal-loop TRẢ LỜI XONG, chat route bắn
 * writebackToKBTransactionally() + extractMemoriesFromConversation()
 * (fire-and-forget, không abortCheck, chạy SONG SONG) — khi NVIDIA hard-block
 * kimi-k3 (429 instant cả 4 key), mỗi call cháy 12 attempts + cooldown 30s
 * lặp lại suốt budget 15 phút → terminal spam 429 "ngay cả khi không làm
 * việc với các agent" (agents đã trả lời xong từ lâu).
 *
 * CHÍNH SÁCH: kimi-k3 là lõi LÀM VIỆC của agents (chat / goal-loop / team) —
 * KHÔNG dành cho utility nền. Utility về bản chất là tác vụ trích xuất /
 * phân loại / chưng cất → dùng chuỗi lõi extraction MODEL-FIRST (directive
 * 2026-09-06: nemotron-3-ultra-550b fail → gpt-oss-120b NGAY cùng key, hết chuỗi
 * mới chuyển key), round-robin start key, KHÔNG BAO GIỜ chạm kimi-k3.
 * Override qua env EXTRACTION_MODEL / EXTRACTION_FALLBACK_MODEL (đi theo lõi
 * extraction) — đặt EXTRACTION_FALLBACK_MODEL=none để tắt tầng fallback.
 */
export async function callUtilityLLM(
  prompt: string,
  systemPrompt?: string,
  task?: string,
  options?: LLMCallOptions
): Promise<LLMResult> {
  const taskLabel = task || 'general'

  console.log(`[LLM] Utility core Task: ${taskLabel}, Prompt: ${prompt.slice(0, 80)}...`)

  // ===== OPENCODE ZEN UTILITY PATH (FIX 2026-09-25 — E2E tool audit) =====
  // Trước đây chỉ có NIM (key chết) → goal-loop-context-compression /
  // memory-extraction / writeback-extraction mỗi lần đốt ~60s chờ cooldown
  // NIM rồi fail-open. Route qua Zen HTTP → OpenCode CLI như callLLM.
  if (isZenConfigured() && !options?.skipZenUtility) {
    const utilModel = process.env.UTILITY_ZEN_MODEL || 'nemotron-3.5-lightning-free'
    const zen = await callZenProvider(prompt, systemPrompt, utilModel, options, `utility-core:${taskLabel}`)
    if (zen && zen.content) {
      console.log(`[LLM] Utility-core dùng Zen ${utilModel} ✓ (${zen.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return zen
    }
    console.warn(`[LLM] Utility-core Zen HTTP ${utilModel} thất bại — thử OpenCode CLI: ${(zen?.error || 'unknown').slice(0, 100)}`)
    const cliResult = await callOpenCodeCLIProvider(prompt, systemPrompt, utilModel, options, `utility-core:${taskLabel}`)
    if (cliResult && cliResult.content) {
      console.log(`[LLM] Utility-core dùng OpenCode CLI ${utilModel} ✓ (${cliResult.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return cliResult
    }
    console.warn(`[LLM] Utility-core Zen ${utilModel} thất bại cả HTTP + CLI — fallback NIM legacy — task: ${taskLabel}`)
  }

  // ===== Z-AI SDK PROVIDER (dựng lại 2026-09-06 — opt-in LLM_PROVIDER=zai) =====
  // Utility defaults giữ nguyên như chuỗi NIM (0.1 / 4096) để hành vi nhất quán.
  if (isZaiProviderEnabled()) {
    const zai = await callZaiProvider(
      prompt,
      systemPrompt,
      `utility:${taskLabel}`,
      { ...options, temperature: options?.temperature ?? 0.1, maxTokens: options?.maxTokens ?? 4096 },
      'utility',
    )
    if (zai) return zai
  }

  const primaryModel = EXTRACTION_MODEL_OVERRIDE || NVIDIA_EXTRACTION_MODELS[0]
  const fallbackModel =
    EXTRACTION_FALLBACK_MODEL_OVERRIDE === 'none' || EXTRACTION_FALLBACK_MODEL_OVERRIDE === ''
      ? (NVIDIA_EXTRACTION_MODELS[1] || '')
      : EXTRACTION_FALLBACK_MODEL_OVERRIDE

  // ===== MODEL-FIRST CHAIN (USER DIRECTIVE 2026-09-06) =====
  // nemotron-3-ultra-550b fail → gpt-oss-120b NGAY (cùng key, round-robin start);
  // cả chuỗi fail trên key mới chuyển key.
  const chain = fallbackModel && fallbackModel !== primaryModel
    ? [primaryModel, fallbackModel]
    : [primaryModel]

  const result = await callModelChainModelFirst(
    chain,
    prompt,
    systemPrompt,
    options,
    {
      startKeyIndex: -1, // round-robin — utility không sở hữu slot key nào
      taskLabel: `utility:${taskLabel}`,
      timeoutMs: 180000, // 180s — utility prompts nhỏ, không cần 300s như extraction chunk lớn
      maxTokens: options?.maxTokens ?? 4096, // utility output nhỏ (JSON phân loại/chưng cất)
      temperature: options?.temperature ?? 0.1,
    },
  )
  if (result?.content) {
    return result
  }

  // abortCheck (nếu caller truyền)
  if (options?.abortCheck && options.abortCheck()) {
    return {
      content: '',
      provider: 'none',
      model: 'none',
      error: `Utility "${taskLabel}" aborted by caller`,
    }
  }

  // Cả 2 lõi đều thất bại — utility là fail-open: caller tự bỏ qua
  console.warn(`[LLM] Utility "${taskLabel}": CẢ HAI lõi (${primaryModel}${fallbackModel ? ` + ${fallbackModel}` : ''}) đều thất bại — caller sẽ fail-open`)
  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: `Utility "${taskLabel}" failed on BOTH cores (${primaryModel}${fallbackModel ? ` + fallback ${fallbackModel}` : ''})`,
  }
}

// ==================== LEGACY CALL (for chat, health, etc.) ====================

// ━━ Z-AI SDK PROVIDER — OPT-IN QUA ENV (Task 21 dựng lại 2026-09-06) ━━
// USER DIRECTIVE (2026-09-06): "Z-AI SDK đã hoạt động trở lại thì thiết lập
// tất cả các agents đều sử dụng Z-ai-sdk" — NIM flaky kéo dài (minimax-m3
// chu kỳ ~7' khỏe / ~8' hang — Task 33/34 dừng 2 dry-run vì lõi hang),
// trong khi z-ai gateway đã ổn định lại (Task 35 verify: 3 lượt OK
// 222-931ms, glm-4-plus, không 429). Kiến trúc OPT-IN giữ nguyên như Task 21
// (đã live-proven qua 5 lượt quan sát 2026-09-03/04):
//   • LLM_PROVIDER=zai  → TOÀN BỘ lõi (agent + chat + utility + extraction)
//     route qua z-ai-web-dev-sdk (GLM gateway sandbox — KHÔNG cần key NVIDIA;
//     gateway tự chọn model, label trả về thường là glm-4-plus).
//   • LLM_PROVIDER=nim / không set → NVIDIA NIM như cũ (default — máy local
//     không có .z-ai-config không bao giờ chạm sdk).
//   • SDK init fail (thiếu package / thiếu config) → tự fall về chuỗi NIM —
//     init-fail được cache + cooldown 60s (không kẹt lặp import mỗi call).
// Chi tiết kiến trúc:
//   - KHÔNG truyền tools/tool_choice (sdk text-only như giai đoạn ecae418 —
//     ENABLE_NATIVE_FC=dual tự fallback regex parse tool_call từ text).
//   - Circuit breaker/prober/key-rotation NIM KHÔNG áp cho zai — pacing gate
//     riêng + 429 circuit riêng (lượt quan sát 3-4), timeout riêng
//     ZAI_TIMEOUT_MS (default 240s, env override).
//   - Token tracking đầy đủ (per-provider 'zai-sdk' + per-agent attribution).
//   - Lịch sử: gỡ 2026-09-04 (gateway 429 kéo dài 8+ giờ) → dựng lại
//     2026-09-06 khi gateway đã lành (Task 35 verify 3 lượt ổn định).

function isZaiProviderEnabled(): boolean {
  const v = (process.env.LLM_PROVIDER || '').trim().toLowerCase()
  return v === 'zai' || v === 'zai-sdk' || v === 'z-ai'
}

/** Minimal structural type cho instance z-ai-sdk (không phụ thuộc type chi tiết của package) */
type ZaiSdkInstance = { chat: { completions: { create: (body: Record<string, unknown>) => Promise<unknown> } } }

/** Cooldown retry sau init fail — không đốt lại import mỗi call */
const ZAI_INIT_RETRY_COOLDOWN_MS = 60_000

/** Singleton cache trên globalThis — Turbopack dev tách module instance theo
 *  route-graph (bài học Task 20 #2) → state dùng globalThis để chia sẻ. */
async function getZaiSdkInstance(): Promise<ZaiSdkInstance | null> {
  const g = globalThis as unknown as {
    __tmoZaiSdkInstance?: ZaiSdkInstance | null
    __tmoZaiInitPromise?: Promise<ZaiSdkInstance | null> | null
    __tmoZaiInitFailedAt?: number
  }
  if (g.__tmoZaiSdkInstance) return g.__tmoZaiSdkInstance
  if (g.__tmoZaiInitPromise) return g.__tmoZaiInitPromise
  if (g.__tmoZaiInitFailedAt && Date.now() - g.__tmoZaiInitFailedAt < ZAI_INIT_RETRY_COOLDOWN_MS) return null
  g.__tmoZaiInitPromise = (async () => {
    try {
      const mod = (await import('z-ai-web-dev-sdk')) as unknown as { default: { create: () => Promise<unknown> } }
      const inst = (await mod.default.create()) as ZaiSdkInstance
      g.__tmoZaiSdkInstance = inst
      console.log('[ZAI] z-ai-sdk khởi tạo OK — provider=zai ACTIVE (model do gateway chọn, thinking disabled)')
      return inst
    } catch (err) {
      g.__tmoZaiInitFailedAt = Date.now()
      console.warn('[ZAI] z-ai-sdk init THẤT BẠI (thiếu package hoặc .z-ai-config — thử lại sau 60s):', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      g.__tmoZaiInitPromise = null
    }
  })()
  return g.__tmoZaiInitPromise
}

// ==================== ZAI RATE-LIMIT DEFENSE (lượt quan sát 3 — 2026-09-04) ====================
// Hiện tượng: b03sdel5 fail 3 attempt CÙNG 1 GIÂY (18:08:22) — z-ai gateway
// burst-limit 429 "Too many requests" khi 2 orchestration chạy song song
// (~10 call/19s). Trước đây 429 bubble thẳng lên caller → đốt hết attempt
// budget tức thời. Fix 2 lớp:
//   (a) Pacing: min-interval giữa START 2 request liên tiếp (chống burst)
//   (b) 429-aware retry: exponential backoff 5s→10s→20s (+jitter) — 429 là
//       transient "try again later", chờ rồi retry là đúng ngữ nghĩa.
function zaiRateLimits(): { minIntervalMs: number; max429Retries: number; backoffBaseMs: number } {
  return {
    // Lượt quan sát 4: 1200→2000ms — llm-mode steps bắn ~40 call/phút (2 call
    // mỗi bước 3s) đẩy gateway vào cửa sổ 429 kéo dài; 2s/call (~30/phút) an
    // toàn hơn mà không chậm đáng kể (LLM response ~1-5s mỗi call).
    minIntervalMs: Math.max(0, parseInt(process.env.ZAI_MIN_INTERVAL_MS || '2000', 10)),
    max429Retries: Math.max(0, parseInt(process.env.ZAI_429_MAX_RETRIES || '3', 10)),
    backoffBaseMs: Math.max(500, parseInt(process.env.ZAI_429_BACKOFF_MS || '5000', 10)),
  }
}

/** Pacing gate — serialize START của các request ZAI cách nhau ≥ minIntervalMs
 *  (state trên globalThis — Turbopack tách module instance theo route-graph). */
async function acquireZaiPacingSlot(taskLabel: string): Promise<void> {
  const { minIntervalMs } = zaiRateLimits()
  if (minIntervalMs === 0) return
  const g = globalThis as unknown as { __tmoZaiLastReqAt?: number; __tmoZaiPaceChain?: Promise<void> }
  const run = async () => {
    const wait = (g.__tmoZaiLastReqAt ?? 0) + minIntervalMs - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    g.__tmoZaiLastReqAt = Date.now()
  }
  g.__tmoZaiPaceChain = (g.__tmoZaiPaceChain ?? Promise.resolve()).then(run, run)
  await g.__tmoZaiPaceChain
  void taskLabel
}

function isRateLimitError(msg: string): boolean {
  return /status 429|too many requests|rate.?limit/i.test(msg)
}

// ── Lượt quan sát 4 (2026-09-04): 429 KÉO DÀI (không còn burst đơn lẻ) ──
// Hiện tượng 20:06:25→20:10:00 (3.5 phút): gateway rate-limit bền vững sau
// chuỗi chạy dày — mỗi call cháy hết 3 retry in-call (35s) vẫn 429. Nếu chỉ
// để từng call tự cháy, orchestration đốt attempt budget mù (b03sdel5 run
// trước may mắn vượt qua nhờ attempt-backoff). Circuit breaker chia sẻ:
//   • Call cháy hết retry 429 → trip cooldown TOÀN CỤC 60s ×2^trips (cap 5')
//   • Call sau vào lúc cooldown đang mở: chat/utility (user-facing) FAIL
//     FAST với lý do rõ; agent/extraction (background orchestration) CHỜ
//     đến khi đóng (cap 300s/lần chờ) rồi gọi lại — pipeline TẠM DỪNG sạch
//     thay vì đốt attempts.
//   • Call thành công → reset trips (traffic khỏe tự mở lại mạch).
const ZAI_429_COOLDOWN_BASE_MS = 60_000
const ZAI_429_COOLDOWN_MAX_MS = 300_000
// Lượt quan sát 4 (chỉnh tiếp): cap chờ = cooldown max — background call chờ
// TRỌN cửa sổ circuit rồi gọi (thay vì fail ở 120s rồi đốt vòng attempt + eval
// mù). Step timeout 600s (SD_LLM_TIMEOUT_MS) chứa vừa 300s chờ + ~35s retry.
const ZAI_429_WAIT_CAP_MS = 300_000

type Zai429Global = { __tmoZai429Until?: number; __tmoZai429Trips?: number }

/** Trip circuit sau khi 429 kéo dài — trả về cooldown áp dụng (ms). */
function tripZai429Cooldown(): number {
  const g = globalThis as unknown as Zai429Global
  g.__tmoZai429Trips = (g.__tmoZai429Trips ?? 0) + 1
  const cd = Math.min(ZAI_429_COOLDOWN_MAX_MS, ZAI_429_COOLDOWN_BASE_MS * 2 ** (g.__tmoZai429Trips - 1))
  g.__tmoZai429Until = Date.now() + cd
  return cd
}

/** Call thành công → traffic khỏe, xóa trips (cooldown hiện tại vẫn tôn trọng). */
function resetZai429Trips(): void {
  ;(globalThis as unknown as Zai429Global).__tmoZai429Trips = 0
}

/** Circuit 429 còn mở? Trả về số ms còn lại (0 = đã đóng). */
function zai429RemainingMs(): number {
  const g = globalThis as unknown as Zai429Global
  return g.__tmoZai429Until ? Math.max(0, g.__tmoZai429Until - Date.now()) : 0
}

/** Trạng thái circuit ZAI cho health/diagnostics UI. */
export function getZai429Status(): { active: boolean; remainingMs: number; trips: number } {
  const g = globalThis as unknown as Zai429Global
  const remaining = zai429RemainingMs()
  return { active: remaining > 0, remainingMs: remaining, trips: g.__tmoZai429Trips ?? 0 }
}

/** Kiểm tra LLM_PROVIDER route qua z-ai (dùng cho health/diagnostics). */
export function isZaiRoutingEnabled(): boolean {
  return isZaiProviderEnabled()
}

/**
 * Gọi z-ai-sdk khi LLM_PROVIDER=zai. Trả về:
 *   - LLMResult THÀNH CÔNG (content + token tracking đầy đủ)
 *   - LLMResult LỖI khi call thật sự fail (timeout/network/empty) — caller
 *     thấy nguyên nhân NGAY, không đốt thêm ~460s chuỗi NIM đang outage
 *   - null khi sdk KHÔNG khả dụng (chưa cài / thiếu config) → caller fall
 *     về chuỗi NIM mặc định (bảo vệ máy local không set LLM_PROVIDER)
 *
 * Lượt quan sát 3: 429 → retry backoff (5s→10s→20s + jitter, tối đa
 * ZAI_429_MAX_RETRIES=3 lần); mỗi request vào qua pacing gate
 * (ZAI_MIN_INTERVAL_MS=2000 mặc định). abortCheck được kiểm lại sau mỗi
 * lần chờ — user bấm Dừng không bị kẹt trong vòng retry.
 */
async function callZaiProvider(
  prompt: string,
  systemPrompt: string | undefined,
  taskLabel: string,
  options: LLMCallOptions | undefined,
  callerKind: 'agent' | 'chat' | 'utility' | 'extraction',
): Promise<LLMResult | null> {
  const { max429Retries, backoffBaseMs } = zaiRateLimits()
  const sdk = await getZaiSdkInstance()
  if (!sdk) return null

  const timeoutMs = parseInt(process.env.ZAI_TIMEOUT_MS || '240000', 10)
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: sanitizeLoneSurrogates(systemPrompt) }] : []),
    { role: 'user', content: sanitizeLoneSurrogates(prompt) },
  ]

  for (let attempt429 = 0; ; attempt429++) {
    // Người dùng bấm Dừng → không đốt call (kiểm lại sau mỗi backoff)
    if (options?.abortCheck && options.abortCheck()) {
      return { content: '', provider: 'zai-sdk', model: 'zai', error: `Task "${taskLabel}" aborted by user` }
    }

    // ── Circuit 429 đang mở (call khác vừa trip): tôn trọng cửa sổ nghỉ ──
    const remain = zai429RemainingMs()
    if (remain > 0) {
      if (callerKind === 'chat' || callerKind === 'utility') {
        return { content: '', provider: 'zai-sdk', model: 'zai', error: `ZAI rate-limited (429 circuit còn ${Math.ceil(remain / 1000)}s) — thử lại sau` }
      }
      // background (agent/extraction): chờ cho cửa sổ đóng (cap 300s/lần chờ)
      const wait = Math.min(remain, ZAI_429_WAIT_CAP_MS)
      console.warn(`[ZAI] ${callerKind}:"${taskLabel}" chờ 429 circuit đóng (còn ${Math.ceil(remain / 1000)}s, chờ tối đa ${Math.ceil(wait / 1000)}s)`)
      await new Promise(r => setTimeout(r, wait))
      if (zai429RemainingMs() > 0) {
        // cooldown dài hơn cap chờ → trả lỗi rõ lý do, caller tự retry theo nhịp riêng
        return { content: '', provider: 'zai-sdk', model: 'zai', error: `ZAI rate-limited (429 circuit còn ${Math.ceil(zai429RemainingMs() / 1000)}s sau khi chờ)` }
      }
    }

    await acquireZaiPacingSlot(taskLabel)

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const res = (await Promise.race([
        sdk.chat.completions.create({
          messages,
          thinking: { type: 'disabled' }, // ưu tiên tốc độ; gateway tự chọn model
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs / 1000}s (ZAI_TIMEOUT_MS)`)), timeoutMs)
        }),
      ])) as {
        choices?: Array<{
          message?: { content?: string; tool_calls?: LLMToolCall[] }
          finish_reason?: string | null
        }>
        model?: string
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      if (timer) clearTimeout(timer)

      const content = res?.choices?.[0]?.message?.content ?? ''
      const nativeToolCalls = res?.choices?.[0]?.message?.tool_calls
      const model = res?.model || 'zai-glm'

      if (!content && !(nativeToolCalls && nativeToolCalls.length > 0)) {
        return { content: '', provider: 'zai-sdk', model, error: `ZAI empty response (${callerKind}:"${taskLabel}")` }
      }

      // Token tracking — mirror attemptNvidiaOnce (per-provider + per-agent)
      const totalTokens = res?.usage?.total_tokens ?? ((res?.usage?.prompt_tokens ?? 0) + (res?.usage?.completion_tokens ?? 0))
      if (totalTokens > 0) addTokensUsed(totalTokens, 'zai-sdk', undefined, model)
      if (totalTokens > 0 && options?.agentId && options.agentName) {
        addTokensUsedByAgent(
          totalTokens,
          res?.usage?.prompt_tokens ?? 0,
          res?.usage?.completion_tokens ?? 0,
          'zai-sdk',
          model,
          options.agentId,
          options.agentName,
        )
      }

      console.log(`[ZAI] ${callerKind}:"${taskLabel}" OK — ${content.length} chars, model ${model}${totalTokens ? `, ${totalTokens} tokens` : ''}`)
      resetZai429Trips()
      return {
        content,
        provider: 'zai-sdk',
        model,
        tokensUsed: totalTokens || undefined,
        tool_calls: nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
        finish_reason: res?.choices?.[0]?.finish_reason ?? null,
      }
    } catch (err) {
      if (timer) clearTimeout(timer)
      const msg = err instanceof Error ? err.message : String(err)
      // ── Lượt quan sát 3: 429 là transient — backoff + retry thay vì bubble
      if (isRateLimitError(msg) && attempt429 < max429Retries) {
        const waitMs = backoffBaseMs * 2 ** attempt429 + Math.floor(Math.random() * 700)
        console.warn(`[ZAI] ${callerKind}:"${taskLabel}" 429 rate-limit (lần ${attempt429 + 1}/${max429Retries}) — retry sau ${Math.round(waitMs / 100) / 10}s`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      // ── Lượt quan sát 4: 429 KÉO DÀI (hết retry in-call) → trip circuit toàn
      // cục — các call sau nghỉ cửa sổ cooldown thay vì tự cháy lặp lại.
      if (isRateLimitError(msg)) {
        const cd = tripZai429Cooldown()
        console.warn(`[ZAI] ${callerKind}:"${taskLabel}" 429 kéo dài sau ${max429Retries} retry — trip circuit cooldown ${Math.round(cd / 1000)}s (background callers sẽ chờ)`)
        return { content: '', provider: 'zai-sdk', model: 'zai', error: `ZAI rate-limited (429 kéo dài — circuit cooldown ${Math.round(cd / 1000)}s)` }
      }
      console.warn(`[ZAI] ${callerKind}:"${taskLabel}" THẤT BẠI:`, msg)
      return { content: '', provider: 'zai-sdk', model: 'zai', error: `ZAI (z-ai-sdk) call failed: ${msg}` }
    }
  } // for attempt429
}


/**
 * Legacy LLM call — NVIDIA NIM only (z-ai-sdk fallback đã gỡ bỏ 2026-10-15).
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

  // ===== Z-AI SDK PROVIDER (dựng lại 2026-09-06 — opt-in LLM_PROVIDER=zai) =====
  // Toàn bộ general chat/health/eval route qua z-ai-sdk khi bật. SDK không
  // khả dụng → null → rơi về chuỗi NIM phía dưới (máy local an toàn).
  if (isZaiProviderEnabled()) {
    const zai = await callZaiProvider(prompt, systemPrompt, taskLabel, options, 'chat')
    if (zai) return zai
  }

  // Phase 4 SMOLAB Prop 11' — explicit model override: try ONLY the requested
  // model. Used by the eval harness (judges must not silently fall back to a
  // rotated model — that would reintroduce circular bias between the answer
  // generator and the judges). No pool-rotation fallback — nhưng vẫn XOAY VÒNG
  // ĐẦY ĐỦ 4 key × 3 lần (user directive 2026-08-31) trước khi trả error.
  if (options?.model) {
    const specific = await callModelWithKeyRotation(options.model, prompt, systemPrompt, options, { taskLabel: `override:${options.model}` })
    if (specific) return specific
    console.log(`[LLM] Model override "${options.model}" failed for task "${taskLabel}" — returning error (no rotation fallback)`)
    return {
      content: '',
      provider: 'none',
      model: options.model,
      error: `NVIDIA NIM model "${options.model}" failed`,
    }
  }

  // ===== OPENCODE ZEN UTILITY PATH (FIX 2026-09-25 — E2E tool audit) =====
  // decompose_task/summarize/synthesize và các utility callLLM() trước đây chỉ có
  // đường NIM (key placeholder chết) → mất ~60s rồi trả content rỗng
  // ("LLM did not return valid JSON" / summary:""). Giờ route qua Zen HTTP →
  // OpenCode CLI (cùng chuỗi callLLMForAgent dùng) TRƯỚC khi rơi về NIM legacy.
  // Model utility mặc định: nemotron-3.5-lightning-free (nhanh, JSON ổn định) —
  // override qua env UTILITY_ZEN_MODEL. skipZenUtility: caller đã thử zen xong.
  if (isZenConfigured() && !options?.skipZenUtility) {
    const utilModel = process.env.UTILITY_ZEN_MODEL || 'nemotron-3.5-lightning-free'
    const zen = await callZenProvider(prompt, systemPrompt, utilModel, options, `utility:${taskLabel}`)
    if (zen && zen.content) {
      console.log(`[LLM] Utility dùng Zen ${utilModel} ✓ (${zen.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return zen
    }
    console.warn(`[LLM] Utility Zen HTTP ${utilModel} thất bại — thử OpenCode CLI: ${(zen?.error || 'unknown').slice(0, 100)}`)
    const cliResult = await callOpenCodeCLIProvider(prompt, systemPrompt, utilModel, options, `utility:${taskLabel}`)
    if (cliResult && cliResult.content) {
      console.log(`[LLM] Utility dùng OpenCode CLI ${utilModel} ✓ (${cliResult.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return cliResult
    }
    console.warn(`[LLM] Utility Zen ${utilModel} thất bại cả HTTP + CLI — fallback NIM legacy (key chết → sẽ trả lỗi) — task: ${taskLabel}`)
  }

  // ===== KIMI-K3 CHÍNH + FALLBACK CHAIN MODEL-FIRST (directive 2026-09-06) =====
  // kimi-k3 fail → fallback tuần tự v4-pro → v4-flash → minimax-m3 NGAY (cùng
  // key); hết cả chuỗi trên key mới chuyển key (callModelChainModelFirst).
  if (isKimiK3Enforced()) {
    return callAgentModelWithFallbackChain(prompt, systemPrompt, options, taskLabel)
  }

  // ===== LEGACY PATH (ENFORCE_KIMI_K3=false) — hành vi cũ =====
  // Try NVIDIA only (single provider)
  const result = await tryNvidia(prompt, systemPrompt, temp, maxTok, aId, aName)
  if (result?.content) return result

  console.log(`[LLM] NVIDIA failed for task "${taskLabel}" — no fallback (z-ai-sdk removed 2026-10-15)`)

  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: 'NVIDIA NIM failed (chuỗi NVIDIA + fallback chain đều lỗi — kiểm tra NVIDIA_API_KEY_1..4 trong .env)',
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
    // prompts can exceed 120s in the reasoning phase → MEGATRON TL timed out every
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

// ==================== OPENCODE ZEN PROVIDER (2026-09-24) ====================
// OpenCode Zen — curated free coding models (OpenAI-compatible API).
// Base URL: https://opencode.ai/zen/v1 (chat/completions)
// Auth: Bearer token (ZEN_API_KEY_1, ZEN_API_KEY_2 — 2-key rotation pool)
//
// Free models used by TMO agents (user directive 2026-09-24):
//   - nemotron-3-ultra-free  (NVIDIA 550B/55B MoE — orchestration + reasoning)
//     → Omega, Opus, MEGATRON (Code Team TL), NEMESIS (Research Team TL)
//   - muse-spark-1.3-contributor-free  (Meta — coding/implementation)
//     → G1/G2/G3 agents (both teams) + ALISTA
//
// Routing: callLLMForAgent checks provider==='zen' BEFORE model-first policy
// (kimi-k3/minimax-m3 enforcement) → zen-routed agents use their configured
// model, not the NIM override. On Zen failure (429/5xx/timeout), falls back
// to the existing NIM kimi-k3 fallback chain (callAgentModelWithFallbackChain).
//
// Known caveats (verified 2026-09-24):
//   - Free models = limited-time promotion, fair-use soft limits (not truly unlimited)
//   - GitHub issue #38028 (Jul 2026): nemotron-3-ultra-free + muse-spark free
//     had transient HTTP 500 failures → NIM fallback chain is mandatory safety net.

const ZEN_BASE_URL = process.env.ZEN_BASE_URL?.trim() || 'https://opencode.ai/zen/v1'
const ZEN_API_KEYS: string[] = [
  process.env.ZEN_API_KEY_1?.trim() || '',
  process.env.ZEN_API_KEY_2?.trim() || '',
].filter(k => k.length > 0)

let zenKeyIndex = 0
// Per-key 429 cooldown timestamp (0 = not rate-limited)
const zenKey429Until: number[] = ZEN_API_KEYS.map(() => 0)

/** Zen is ready to serve calls (at least 1 key configured). */
function isZenConfigured(): boolean {
  return ZEN_API_KEYS.length > 0
}

/** Pick next available Zen key (skip rate-limited; round-robin otherwise). */
function getZenKey(): { key: string; index: number } | null {
  if (ZEN_API_KEYS.length === 0) return null
  const now = Date.now()
  for (let i = 0; i < ZEN_API_KEYS.length; i++) {
    const idx = (zenKeyIndex + i) % ZEN_API_KEYS.length
    if (zenKey429Until[idx] <= now) {
      zenKeyIndex = (idx + 1) % ZEN_API_KEYS.length
      return { key: ZEN_API_KEYS[idx], index: idx }
    }
  }
  // All keys rate-limited — pick the one with soonest reset (fail-open, still try)
  let soonest = 0
  let soonestAt = zenKey429Until[0]
  for (let i = 1; i < zenKey429Until.length; i++) {
    if (zenKey429Until[i] < soonestAt) { soonest = i; soonestAt = zenKey429Until[i] }
  }
  return { key: ZEN_API_KEYS[soonest], index: soonest }
}

/** Mark a Zen key as rate-limited (60s cooldown). */
function markZenKey429(index: number): void {
  zenKey429Until[index] = Date.now() + 60000
}

/**
 * Call OpenCode Zen provider (OpenAI-compatible API).
 * Used when agent's configured provider === 'zen'.
 * Returns LLMResult with empty content + error on failure (caller falls back to NIM).
 */
async function callZenProvider(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  options: LLMCallOptions | undefined,
  taskLabel: string,
): Promise<LLMResult | null> {
  const keyInfo = getZenKey()
  if (!keyInfo) {
    console.warn('[ZEN] No API keys configured (set ZEN_API_KEY_1 / ZEN_API_KEY_2 in .env)')
    return null
  }

  const timeoutMs = parseInt(process.env.ZEN_TIMEOUT_MS || '120000', 10)
  const maxTokens = options?.maxTokens ?? 16384
  const temperature = options?.temperature ?? 0.4

  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: sanitizeLoneSurrogates(systemPrompt) }] : []),
    { role: 'user', content: sanitizeLoneSurrogates(prompt) },
  ]

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  }
  if (options?.tools && options.tools.length > 0) {
    try {
      body.tools = sanitizeToolSchemasDeep(options.tools)
    } catch {
      body.tools = options.tools
    }
    body.tool_choice = options.tool_choice ?? 'auto'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyInfo.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (response.status === 429) {
      markZenKey429(keyInfo.index)
      let errBody = ''
      try { errBody = await response.text() } catch { /* ignore */ }
      console.warn(`[ZEN] ${taskLabel} 429 rate-limited (key #${keyInfo.index + 1}) — cooldown 60s: ${errBody.slice(0, 120)}`)
      return { content: '', provider: 'zen', model, error: `Zen 429 rate-limited (key #${keyInfo.index + 1})` }
    }

    if (!response.ok) {
      let errBody = ''
      try { errBody = await response.text() } catch { /* ignore */ }
      console.warn(`[ZEN] ${taskLabel} HTTP ${response.status}: ${errBody.slice(0, 200)}`)
      return { content: '', provider: 'zen', model, error: `Zen HTTP ${response.status}: ${errBody.slice(0, 150)}` }
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: LLMToolCall[] }
        finish_reason?: string | null
      }>
      model?: string
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }

    const choice = data.choices?.[0]
    const content = choice?.message?.content ?? ''
    const nativeToolCalls = choice?.message?.tool_calls
    const finishReason = choice?.finish_reason ?? null
    const actualModel = data.model || model
    const totalTokens = data.usage?.total_tokens ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0))

    if (!content && !(nativeToolCalls && nativeToolCalls.length > 0)) {
      return { content: '', provider: 'zen', model: actualModel, error: `Zen empty response (${taskLabel})` }
    }

    // Token tracking — per-provider + per-agent (mirror NIM pattern)
    if (totalTokens > 0) addTokensUsed(totalTokens, 'zen', keyInfo.index, actualModel)
    if (totalTokens > 0 && options?.agentId && options?.agentName) {
      addTokensUsedByAgent(
        totalTokens,
        data.usage?.prompt_tokens ?? 0,
        data.usage?.completion_tokens ?? 0,
        'zen',
        actualModel,
        options.agentId,
        options.agentName,
      )
    }

    console.log(`[ZEN] ${taskLabel} OK — ${content.length} chars, model ${actualModel}${totalTokens ? `, ${totalTokens} tokens` : ''}`)
    return {
      content,
      provider: 'zen',
      model: actualModel,
      tokensUsed: totalTokens || undefined,
      tool_calls: nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : undefined,
      finish_reason: finishReason,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[ZEN] ${taskLabel} THẤT BẠI:`, msg)
    return { content: '', provider: 'zen', model, error: `Zen call failed: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

// ==================== OPENCODE CLI PROVIDER (2026-09-24 — FreeTierError workaround) ====================
// OpenCode Zen free models (suffix -free) chỉ gọi được từ TRONG OpenCode platform.
// External HTTP API → FreeTierError 403. Workaround: spawn `opencode run` CLI
// subprocess — CLI auth khác HTTP auth, free models CHẠY THẬT (verified 2026-09-24).
//
// Output format: `--format json` stream events (step_start, text, step_finish).
// Parse text events → accumulate content + reasoning + tokens.
// Fallback: CLI fail → caller (callLLMForAgent) fallback NIM kimi-k3 chain.

const OPENCODE_CLI_BIN = process.env.OPENCODE_CLI_BIN?.trim() || '/home/z/.opencode/bin/opencode'
const OPENCODE_CLI_ENABLED = (process.env.OPENCODE_CLI_ENABLED || 'true').trim().toLowerCase() !== 'false'
const OPENCODE_CLI_TIMEOUT_MS = parseInt(process.env.OPENCODE_CLI_TIMEOUT_MS || '240000', 10)

/** Check if OpenCode CLI binary exists + enabled. */
function isOpenCodeCLIAvailable(): boolean {
  if (!OPENCODE_CLI_ENABLED) return false
  try {
    // Quick sync check — existsSync is cheap
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs')
    return fs.existsSync(OPENCODE_CLI_BIN)
  } catch {
    return false
  }
}

// ==================== CLI-NATIVE TOOL ACTIVITY → AGENT ACTIVITY LOG ====================
// (user request 2026-09-25: "agent viết đến đâu code hiện đến đấy" + Terminal
// hiện lệnh/kết quả thật) — tool CLI-native (bash/write/edit/read/glob/grep/
// todowrite) chạy BÊN TRONG inner loop của OpenCode CLI process, KHÔNG đi qua
// executeTool() của app → trước đây hoàn toàn VÔ HÌNH ở Code tab: không có
// terminal echo, không reload file tree, tab editor mở sẵn giữ content STALE.
//
// Giải pháp: mỗi tool_use event của CLI-native tool được ghi vào agent-activity
// ring buffer (choke-point mà Terminal UI poll 2.5s) với tên tool MAPPED về tên
// TMO tương đương (bash→shell, write→file_write...) → các logic sẵn có bên
// client (FILE_MUTATING_TOOLS reload tree, echo format `$ [AI·x]`/`⎿ result`,
// live tab refresh mới) tự động ăn theo — hoạt động ở MỌI mode (GoalLoop chat,
// Self-Direction steps, subagent, cron) vì tất cả đều chảy qua provider này.
//
// KHÔNG ghi cho tmo_* bridge tools — các tool đó đã được executeTool() ghi qua
// POST /api/tools/execute (tránh double entry cho cùng 1 hành động).
const CLI_NATIVE_ACTIVITY_TOOL_MAP: Record<string, string> = {
  bash: 'shell',
  write: 'file_write',
  edit: 'file_edit',
  read: 'file_read',
  glob: 'file_list',
  ls: 'file_list',
  grep: 'grep',
  todowrite: 'todo_write',
}

/** State shape của tool_use event (verified thực tế 2026-09-25 bằng probe CLI). */
interface CliToolState {
  status?: string
  input?: unknown
  output?: string
  error?: string
  time?: { start?: number; end?: number }
}

async function recordCliNativeToolActivity(
  cliToolName: string,
  state: CliToolState | undefined,
  agentName: string | undefined,
  sessionId?: string | null,
): Promise<void> {
  try {
    if (cliToolName.startsWith('tmo_')) return // đã ghi bởi executeTool qua bridge
    const tmoName = CLI_NATIVE_ACTIVITY_TOOL_MAP[cliToolName]
    if (!tmoName) return // tool lạ ('invalid', plugin khác...) — bỏ
    const input = (state?.input && typeof state.input === 'object' ? state.input : {}) as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    let detail = ''
    if (tmoName === 'shell') {
      detail = str(input.command)
    } else if (tmoName === 'file_write' || tmoName === 'file_edit' || tmoName === 'file_read') {
      detail = str(input.filePath) || str(input.path) || str(input.file_path)
    } else if (tmoName === 'grep' || tmoName === 'file_list') {
      detail = str(input.pattern) || str(input.path) || '.'
    } else if (tmoName === 'todo_write') {
      detail = `todo list (${Array.isArray(input.todos) ? input.todos.length : '?'} mục)`
    }
    const dur = typeof state?.time?.start === 'number' && typeof state?.time?.end === 'number'
      ? Math.max(0, state.time.end - state.time.start)
      : 0
    const ok = state?.status !== 'error'
    const resultPreview = ok
      ? (typeof state?.output === 'string' && state.output ? state.output.slice(0, 900) : undefined)
      : `ERROR: ${typeof state?.error === 'string' ? state.error : 'tool call lỗi/bị từ chối'}`
    const { recordAgentActivity } = await import('@/lib/agent-activity-log')
    recordAgentActivity({
      agentName,
      tool: tmoName,
      detail,
      success: ok,
      durationMs: dur,
      // 2026-09-26 FIX (Tool health audit): truyền sessionId thật của agent run
      // (trước đây null cứng → ToolMetric rơi vào session 'unknown' — Tool health
      // không truy vết được run nào gọi tool native CLI)
      sessionId: sessionId || null,
      resultPreview,
    })
  } catch { /* fail-open — hiển thị activity không được phép crash LLM call */ }
}

/** 2026-10 — map tên tool CLI (tmo_* filename + native) → tên TMO executeTool.
 *  Trước đây khai báo LẶP bên trong stream handler; đưa ra module-level để
 *  collector kết quả (executedResultMap) + collector tool_calls dùng chung. */
const OC_CLI_TOOL_MAP: Record<string, string> = {
  'tmo_delegate': 'delegate_task',
  'tmo_dispatch': 'dispatch_agent',
  'tmo_escalate': 'escalate_problem',
  'tmo_knowledge_search': 'knowledge_search',
  'tmo_knowledge_graph': 'knowledge_graph',
  'tmo_file_list': 'file_list',
  'tmo_file_read': 'file_read',
  'tmo_grep': 'grep',
  'tmo_shell': 'shell',
  'tmo_todo': 'todo_write',
  'tmo_request_code_team': 'request_code_team',
  'tmo_web_search': 'web_search',
  // 2026-09-25 SKILLS BRIDGE — 2 bridge tools trong .opencode/tools/ cho CLI
  // gọi list_skills/read_skill của app (per-agent SkillAssignment filter vẫn
  // áp dụng vì context.agentName = TMO_AGENT_NAME).
  'tmo_list_skills': 'list_skills',
  'tmo_read_skill': 'read_skill',
  // Task 21 (2026-10-21) — SHR bridge tool
  'tmo_hypothesis': 'hypothesis_write',
  // 2026-10 FIX MATCH TÊN — native CLI tool names → TMO names (mirror
  // TOOL_NAME_ALIASES trong code-team/tool-executor.ts). QUAN TRỌNG:
  // executed_tool_calls (function.name = mappedName) được goal-loop đưa qua
  // resolveToolAlias → 'bash' trở thành 'shell'; executed_tool_results dùng
  // CÙNG map này nên 2 bên ĐỒNG NHẤT tên khi goal-loop match kết quả thật
  // (findIndex r.name === etc.name). Trước đây native giữ nguyên 'bash' trong
  // results trong khi calls thành 'shell' → match FAIL → evidence mất output
  // thật → evaluator mù → chu kỳ lặp (đã lộ ra trong E2E procint cycle 1-15).
  bash: 'shell',
  sh: 'shell',
  read: 'file_read',
  write: 'file_write',
  edit: 'file_edit',
  multiedit: 'file_multi_edit',
  multi_edit: 'file_multi_edit',
  todowrite: 'todo_write',
  todoread: 'todo_read',
  glob: 'file_list',
  ls: 'file_list',
}

/**
 * Call OpenCode Zen free model via CLI subprocess (bypasses FreeTierError).
 * Spawns `opencode run "prompt" --model opencode/<model> --format json`.
 * Returns LLMResult with content + tokens. On failure → null (caller falls back).
 */
async function callOpenCodeCLIProvider(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  options: LLMCallOptions | undefined,
  taskLabel: string,
): Promise<LLMResult | null> {
  if (!isOpenCodeCLIAvailable()) {
    console.warn(`[OC-CLI] Binary không tồn tại tại ${OPENCODE_CLI_BIN} — set OPENCODE_CLI_BIN hoặc cài opencode CLI`)
    return null
  }

  const { spawn } = await import('child_process')
  // Top-level import (sync) để dùng trong child.on('close') callback — không dùng await trong callback.
  const { extractToolCallsWithDiagnostics } = await import('@/lib/tool-calls')
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt
  // MULTI-KEY ROTATION (fix 2026-09-25): opencode.json định nghĩa 3 provider
  // alias trùng baseURL https://opencode.ai/zen/v1, khác API key:
  //   - opencode    → key repo (mặc định, quota riêng)
  //   - opencode-k1 → ZEN_API_KEY_1   ┐ pool round-robin DÙNG CHUNG với
  //   - opencode-k2 → ZEN_API_KEY_2   ┘ Zen HTTP path (getZenKey)
  // Chọn prefix theo pool state → CLI không còn phụ thuộc 1 key duy nhất;
  // key nào bị HTTP path đánh dấu 429-cooldown sẽ tự bị bỏ qua ở lần spawn sau.
  // Không có env key → dùng alias mặc định `opencode` (auth.json/opencode.json).
  let cliProviderPrefix = 'opencode'
  try {
    const keyInfo = getZenKey()
    if (keyInfo) cliProviderPrefix = `opencode-k${keyInfo.index + 1}`
  } catch { /* giữ prefix mặc định */ }
  const cliModel = `${cliProviderPrefix}/${model}`

  console.log(`[OC-CLI] ${taskLabel} — spawn opencode run --model ${cliModel}`)
  return new Promise<LLMResult | null>((resolve) => {
    // CLI syntax: `opencode run "<message>" --model opencode/<model> --format json`
    // message as positional arg. Long prompts with newlines → pipe via stdin.
    const args = [
      'run', fullPrompt,
      '--model', cliModel,
      '--format', 'json',
    ]
    const child = spawn(OPENCODE_CLI_BIN, args, {
      cwd: process.env.OPENCODE_WORKSPACE || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
        TERM: 'dumb',
        // Pass TMO context to custom tools (.opencode/tools/*.ts read these)
        TMO_BASE_URL: process.env.TMO_BASE_URL || 'http://localhost:3000',
        TMO_AGENT_NAME: options?.agentName || 'opencode-bridge',
        // 2026-09-26 FIX: truyền sessionId thật (trước đây '' → bridge ghi
        // ToolMetric session 'unknown', tách khỏi run — Tool health khó truy vết)
        TMO_SESSION_ID: options?.sessionId || '',
        // 2026-10-20 TASK 20: truyền runId thật — todo_write từ inner loop CLI
        // (tmo_todo bridge) gắn đúng run → TODO block + auto-complete hoạt động
        // trên đường CLI (trước đây todos CLI luôn runId=null → kế hoạch MẤT
        // giữa các chu kỳ dù F4 đã render — gap phát hiện khi rà soát Task 19)
        TMO_RUN_ID: options?.runId || '',
      },
      timeout: OPENCODE_CLI_TIMEOUT_MS,
    })
    // Close stdin immediately — signal non-interactive mode (prevent TTY wait)
    child.stdin?.end()
    child.stdin?.on('error', () => { /* ignore EPIPE if child exits early */ })

    let stdout = ''
    let stderr = ''
    let contentParts: string[] = []
    let reasoningParts: string[] = []
    let totalTokens = 0
    let inputTokens = 0
    let outputTokens = 0
    let actualModel = model
    let finishReason: string | null = null
    let resolved = false
    // Collect tool_use events — OpenCode emits these when LLM calls custom tools
    // (tmo_delegate, tmo_file_list, etc.). Map tmo_* prefix → TMO tool names.
    const collectedToolCalls: LLMToolCall[] = []
    // 2026-10 PROCESS INTEGRITY — thu KẾT QUẢ THẬT của tool CLI đã thực thi
    // (state.{status,output,error,time} có trong event — trước đây bị bỏ).
    // Map theo callId; snapshot sau GHI ĐÈ snapshot trước (giữ state mới nhất).
    const executedResultMap = new Map<string, ExecutedToolResult>()
    const seenCallIds = new Set<string>()


    const finishTimer = setTimeout(() => {
      if (!resolved) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        console.warn(`[OC-CLI] ${taskLabel} timeout ${OPENCODE_CLI_TIMEOUT_MS}ms — kill`)
        // (fix 2026-09-25) PARTIAL-ON-TIMEOUT: inner loop CLI có thể ĐÃ thực thi
        // nhiều tool trước khi bị kill (E2E 2026-09-25: SENTINEL edit+bash thật
        // nhưng resolve(null) vứt bỏ toàn bộ → evaluator kết luận oan "không có
        // tool call nào"). Giờ trả partial: content rỗng + executed_tool_calls
        // đã thu thập → callLLMForAgent pass (tool_calls non-empty) → caller
        // (self-direction receipts bridge) ghi nhận bằng chứng việc đã làm;
        // content trống → caller tổng hợp output trung thực từ receipts.
        resolve({
          content: '',
          provider: 'zen-cli',
          model: actualModel,
          tokensUsed: totalTokens || undefined,
          error: `timeout ${OPENCODE_CLI_TIMEOUT_MS}ms (partial — ${collectedToolCalls.length} tool đã thực thi trước khi kill)`,
          tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
          executed_tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
          executed_tool_results: executedResultMap.size > 0 ? [...executedResultMap.values()] : undefined,
          reasoning: reasoningParts.join('').trim() || undefined,
          finish_reason: 'timeout',
        })
        resolved = true
      }
    }, OPENCODE_CLI_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      // Parse JSON lines (NDJSON stream)
      const lines = stdout.split('\n')
      stdout = lines.pop() || '' // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const evt = JSON.parse(trimmed) as {
            type?: string
            part?: {
              type?: string
              text?: string
              tokens?: { total?: number; input?: number; output?: number; reasoning?: number }
              reason?: string
              // Tool use event shape (OpenCode CLI emits these for custom tools)
              name?: string
              tool?: string
              input?: unknown
              state?: { input?: unknown; output?: string; status?: string; error?: string; time?: { start?: number; end?: number } }
              tool_call_id?: string
              callID?: string
              callId?: string
            }
            timestamp?: number
          }
          if (evt.type === 'text' && evt.part?.text) {
            // First text often is reasoning; later text is output.
            // Heuristic: reasoning tokens tracked separately if part.type === 'reasoning'
            if (evt.part.type === 'reasoning') {
              reasoningParts.push(evt.part.text)
            } else {
              contentParts.push(evt.part.text)
            }
          }
          // Parse tool_use events — OpenCode CLI calls custom tmo_* tools
          // Event shape: part.tool = tool name, part.state.input = args, part.state.output = result
          if ((evt.type === 'tool_use' || evt.type === 'tool_result') && (evt.part?.name || evt.part?.tool)) {
            const toolName = evt.part.name || evt.part.tool || ''
            const toolCallId = evt.part.tool_call_id || evt.part.callID || evt.part.callId || ''
            // Explicit mapping (tmo_* filename → TMO executeTool name) — module-level
            // OC_CLI_TOOL_MAP (2026-10: dùng chung cho collector kết quả + collector
            // tool_calls, không khai báo lặp trong handler)
            const mappedName = OC_CLI_TOOL_MAP[toolName] || toolName
            // 2026-10 — thu kết quả thật từ MỌI tool event (use + result).
            // Fail-open: parse state lỗi không được phép crash stream parse.
            try {
              const st = evt.part.state
              const inputRaw = evt.part.input || st?.input || {}
              const inputArgs = (inputRaw && typeof inputRaw === 'object' ? inputRaw : {}) as Record<string, unknown>
              const key = toolCallId || `${toolName}#${executedResultMap.size}`
              const prev = executedResultMap.get(key)
              const status = typeof st?.status === 'string' && st.status ? st.status : (evt.type === 'tool_result' ? 'completed' : 'unknown')
              const output = typeof st?.output === 'string' ? st.output.slice(0, 2000) : (prev?.output || '')
              const error = typeof st?.error === 'string' ? st.error.slice(0, 1000) : prev?.error
              const dur = typeof st?.time?.start === 'number' && typeof st?.time?.end === 'number'
                ? Math.max(0, st.time.end - st.time.start)
                : (prev?.durationMs ?? 0)
              executedResultMap.set(key, {
                callId: toolCallId || '',
                name: mappedName,
                cliName: toolName,
                args: Object.keys(inputArgs).length > 0 ? inputArgs : (prev?.args ?? {}),
                output: output || prev?.output || '',
                error,
                status,
                success: status !== 'error' && !error,
                durationMs: dur,
              })
            } catch { /* fail-open — parse state không crash stream */ }
            // Only collect on tool_use (not tool_result — result is already executed by OpenCode).
            // 2026-10: dedup theo callId KHÔNG rỗng — CLI có thể phát nhiều snapshot
            // cho cùng 1 call (running → completed); trước đây mỗi snapshot push 1
            // entry → tool bị đếm nhiều lần trong collectedToolCalls.
            if (evt.type === 'tool_use' && !(toolCallId && seenCallIds.has(toolCallId))) {
              if (toolCallId) seenCallIds.add(toolCallId)
              const inputArgs = evt.part.input || evt.part.state?.input || {}
              collectedToolCalls.push({
                id: toolCallId || `occli_${Date.now()}_${collectedToolCalls.length}`,
                type: 'function',
                function: {
                  name: mappedName,
                  arguments: typeof inputArgs === 'string' ? inputArgs : JSON.stringify(inputArgs),
                },
              })
              console.log(`[OC-CLI] ${taskLabel} tool_use: ${toolName} → ${mappedName}`)
              // 2026-09-25: CLI-native tools (bash/write/edit...) → agent-activity
              // log (Terminal echo + tree reload + live tab refresh ở Code tab).
              // Fire-and-forget — không chặn stream parse.
              // 2026-09-26: truyền sessionId (Tool health attribution).
              void recordCliNativeToolActivity(toolName, evt.part.state as CliToolState | undefined, options?.agentName, options?.sessionId)
            }
          }
          if (evt.type === 'step_finish' && evt.part?.tokens) {
            totalTokens += evt.part.tokens.total || 0
            inputTokens += evt.part.tokens.input || 0
            outputTokens += evt.part.tokens.output || 0
            if (evt.part.reason) finishReason = evt.part.reason
          }
        } catch { /* not JSON line — ignore (CLI banner etc) */ }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(finishTimer)
      console.warn(`[OC-CLI] ${taskLabel} spawn error:`, err.message)
      resolve(null)
    })

    child.on('close', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(finishTimer)

      const content = contentParts.join('').trim()
      const reasoning = reasoningParts.join('').trim()

      if (!content && code !== 0) {
        console.warn(`[OC-CLI] ${taskLabel} exit ${code} — no content. stderr: ${stderr.slice(0, 200)}`)
        resolve(null)
        return
      }

      // Parse tool_calls từ content (TMO text-based tool_call syntax:
      // `tool_call: <name>({...})`). OpenCode CLI không return native tool_calls
      // nhưng model vẫn output tool_call text theo system prompt của TMO.
      // Goal-loop/ReAct loop parse text này → executeTool.
      let parsedToolCalls: LLMToolCall[] | undefined
      let cleanedContent = content
      try {
        const diag = extractToolCallsWithDiagnostics(content)
        if (diag.calls.length > 0) {
          parsedToolCalls = diag.calls.map(c => ({
            id: `occli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          }))
          // extractToolCallsWithDiagnostics returns cleaned content (tool_call text removed)
          // qua extractFencedFileWrites inner — nhưng diag interface chỉ expose calls + parseFailures.
          // cleanedContent = content với tool_call text lines removed (best-effort).
          cleanedContent = content.replace(/tool_call:\s*\w+\s*\(\s*\{[^]*?\}\s*\)\s*/g, '').trim()
          console.log(`[OC-CLI] ${taskLabel} parsed ${diag.calls.length} tool_call(s) from content: ${diag.calls.map(c => c.name).join(', ')}`)
        }
      } catch (parseErr) {
        // tool-calls import fail (rare) → return raw content, caller tự parse
        console.warn(`[OC-CLI] ${taskLabel} tool_call parse skipped:`, parseErr instanceof Error ? parseErr.message : String(parseErr))
      }

      // Merge collectedToolCalls (from OpenCode tool_use events) + parsedToolCalls (from text)
      // OpenCode custom tools (tmo_*) → already mapped to TMO names in collectedToolCalls.
      // Text-based tool_call (legacy TMO syntax) → parsedToolCalls.
      const allToolCalls: LLMToolCall[] | undefined =
        (collectedToolCalls.length > 0 || (parsedToolCalls && parsedToolCalls.length > 0))
          ? [...collectedToolCalls, ...(parsedToolCalls || [])]
          : undefined

      // Token tracking
      if (totalTokens > 0) addTokensUsed(totalTokens, 'zen-cli', 0, actualModel)
      if (totalTokens > 0 && options?.agentId && options?.agentName) {
        addTokensUsedByAgent(totalTokens, inputTokens, outputTokens, 'zen-cli', actualModel, options.agentId, options.agentName)
      }

      console.log(`[OC-CLI] ${taskLabel} OK — ${content.length} chars${reasoning ? `, ${reasoning.length} reasoning chars` : ''}${totalTokens ? `, ${totalTokens} tokens` : ''}${allToolCalls ? `, ${allToolCalls.length} tool_calls` : ''}`)

      resolve({
        content: cleanedContent,
        provider: 'zen-cli',
        model: actualModel,
        tokensUsed: totalTokens || undefined,
        tool_calls: allToolCalls,
        // (fix 2026-09-25) executed-only: tool calls inner loop CLI ĐÃ CHẠY THẬT
        // (tmo_* bridge + native). Text-protocol parsed calls KHÔNG nằm đây —
        // chúng chưa chạy và do caller (ReAct loop) thực thi theo protocol.
        executed_tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
        // 2026-10 — kết quả thật + reasoning (xem interface ExecutedToolResult)
        executed_tool_results: executedResultMap.size > 0 ? [...executedResultMap.values()] : undefined,
        reasoning: reasoning || undefined,
        finish_reason: finishReason,
      })
    })
  })
}

/** Health/status info for Zen provider (used by /api/health + Database module UI). */
export function getZenStatus(): {
  configured: boolean
  keyCount: number
  availableKeys: number
  rateLimitedKeys: number
  models: string[]
} {
  const now = Date.now()
  const rateLimited = zenKey429Until.filter((t, i) => i < ZEN_API_KEYS.length && t > now).length
  return {
    configured: ZEN_API_KEYS.length > 0,
    keyCount: ZEN_API_KEYS.length,
    availableKeys: ZEN_API_KEYS.length - rateLimited,
    rateLimitedKeys: rateLimited,
    models: ['nemotron-3-ultra-free', 'muse-spark-1.3-contributor-free'],
  }
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

  // ===== OPENCODE ZEN PROVIDER (2026-09-24 — user directive) =====
  // Agents configured with provider='zen' route to OpenCode Zen (free coding
  // models: nemotron-3-ultra-free for TL/Omega/Opus, muse-spark-1.3-contributor-free
  // for generators). Zen check runs BEFORE model-first policy (kimi-k3 enforcement)
  // so zen-routed agents use their configured model. On Zen failure → fall back
  // to the existing NIM kimi-k3 fallback chain (safety net for transient Zen 429/5xx).
  if (provider === 'zen' && isZenConfigured()) {
    const zen = await callZenProvider(prompt, systemPrompt, model, options, `agent:${model}`)
    if (zen && (zen.content || (zen.tool_calls && zen.tool_calls.length > 0))) {
      const tcCount = zen.tool_calls?.length ?? 0
      console.log(`[LLM] Agent dùng Zen ${model} ✓ (${tcCount} tool_calls, ${zen.tokensUsed ?? 0} tokens)`)
      return zen
    }
    // Zen HTTP failed (FreeTierError 403 / 429 / 5xx) → try OpenCode CLI provider
    // (free models chỉ gọi được qua CLI, không qua HTTP API)
    console.warn(`[LLM] Agent Zen HTTP ${model} thất bại — thử OpenCode CLI provider: ${(zen?.error || 'unknown').slice(0, 100)}`)
    const cliResult = await callOpenCodeCLIProvider(prompt, systemPrompt, model, options, `agent:${model}`)
    if (cliResult && (cliResult.content || (cliResult.tool_calls && cliResult.tool_calls.length > 0))) {
      const tcCount = cliResult.tool_calls?.length ?? 0
      console.log(`[LLM] Agent dùng OpenCode CLI ${model} ✓ (${tcCount} tool_calls, ${cliResult.tokensUsed ?? 0} tokens)`)
      return cliResult
    }
    // Both Zen HTTP + CLI failed → fall back to NIM kimi-k3 chain (safety net)
    console.warn(`[LLM] Agent Zen ${model} thất bại cả HTTP + CLI — fallback NIM kimi-k3 chain`)
    const nimFallback = await callAgentModelWithFallbackChain(prompt, systemPrompt, options, `agent:${model}-zen-fallback`)
    const tcCount = nimFallback.tool_calls?.length ?? 0
    if (nimFallback.content || tcCount > 0) {
      console.log(`[LLM] Agent fallback NIM ${nimFallback.model} ✓ (${tcCount} tool_calls) — Zen ${model} đã fail`)
    }
    return nimFallback
  }

  // ===== Z-AI SDK PROVIDER (dựng lại 2026-09-06 — opt-in LLM_PROVIDER=zai) =====
  // Agent calls (goal-loop, research team, code-team, smolab...) route qua
  // z-ai-sdk khi bật — model NIM cấu hình bị bỏ qua (gateway tự chọn GLM).
  if (isZaiProviderEnabled()) {
    const zai = await callZaiProvider(prompt, systemPrompt, `agent:${model}`, options, 'agent')
    if (zai) return zai
  }

  // ===== KIMI-K3 CHÍNH + FALLBACK CHAIN MODEL-FIRST (directive 2026-09-06) =====
  // "deepseek v4 pro, deepseek v4 flash, minimax lần lượt làm fall back cho k3" —
  // cấu hình model riêng của agent vẫn bị override về kimi-k3 (lõi chính); khi
  // kimi-k3 fail → fallback tuần tự qua 3 lõi kia NGAY (cùng key), chỉ hết cả
  // chuỗi mới chuyển key (callAgentModelWithFallbackChain).
  if (isKimiK3Enforced()) {
    if (model !== KIMI_K3_MODEL) {
      // NOTE: không bracket trước tên model (dev.log strip ANSI ăn "[m") — xem ghi chú banner phía trên.
      console.log(`[LLM] MODEL POLICY: agent cấu hình ${provider}/${model} → override → ${KIMI_K3_MODEL} (lõi chính) + fallback chain: ${AGENT_FALLBACK_CHAIN.join(' → ')}`)
    }
    const result = await callAgentModelWithFallbackChain(prompt, systemPrompt, options, `agent:${model}`)
    const tcCount = result.tool_calls?.length ?? 0
    if (result.content || tcCount > 0) {
      console.log(`[LLM] Agent dùng lõi ${result.model} ✓ (${tcCount} tool_calls) — agent cấu hình gốc: ${provider}/${model}`)
      return result
    }
    // (2026-10-15) z-ai-sdk fallback đã GỠ BỎ theo user directive — trả thẳng
    // LLMResult lỗi của chuỗi NVIDIA để caller nhìn thấy nguyên nhân thật
    // (key/timeout/model) thay vì mất thêm 15-20s chờ import sdk thất bại.
    console.warn(`[LLM] Agent chain NVIDIA thất bại (no fallback — z-ai-sdk removed 2026-10-15): ${(result.error || 'unknown error').slice(0, 200)}`)
    return result
  }

  // ===== LEGACY PATH (ENFORCE_KIMI_K3=false) — tôn trọng cấu hình per-agent =====
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
  // (FIX 2026-09-25: skipZenUtility — zen HTTP + CLI đã thử ở trên, không lặp lại)
  console.log(`[LLM] Agent provider ${provider}/${model} failed, falling back to global pool`)
  return callLLM(prompt, systemPrompt, 'agent-fallback', { ...options, skipZenUtility: true })
}

// ==================== UTILITY EXPORTS ====================

export function getNvidiaModels(): string[] { return [...NVIDIA_MODELS] }


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
