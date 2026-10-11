/**
 * Shared LLM Calling Module for GraphRAG
 *
 * ⚠ MODEL MATRIX (USER DIRECTIVE 2026-11-30 — thay thế toàn bộ chính sách cũ):
 *   NVIDIA NIM dễ 429 kéo dài với tác vụ phức tạp/dài hạn → NIM CHỈ giữ 2 vai trò:
 *     1. LÕI EMBED (src/lib/embeddings.ts — nvidia/nemotron-3-embed-1b)
 *     2. LÕI TRÍCH XUẤT (triết tách) — nvidia/nemotron-3-ultra-550b-a55b là lõi
 *        extraction CHÍNH (callLLMSlot: NIM nemotron-550b trước, fail toàn chuỗi
 *        key → fallback chuỗi Zen space-bunny-free cho pipeline không chết)
 *   - kimi-k3 (moonshotai/kimi-k3) GIỮ LẠI như 1 LỰA CHỌN model agent TẠM THỜI
 *     (dropdown Smolab/Agents chọn kimi-k3 → callLLMForAgent route THẬT qua NIM
 *     kimi-k3; NIM chết/429 kéo dài → tự fallback chuỗi Zen space-bunny-free)
 *   - ĐÃ LOẠI BỎ TOÀN BỘ (user directive 2026-11-30 "toàn bộ loại bỏ luôn" —
 *     xác nhận 410 EOL live-probe 2026-11-30):
 *     minimaxai/minimax-m3 (EOL 2026-09-09), deepseek-ai/deepseek-v4-pro-0813
 *     (EOL 2026-09-14), deepseek-ai/deepseek-v4-flash-0731 (EOL 2026-09-21),
 *     openai/gpt-oss-120b (EOL 2026-09-03 — lõi extraction fallback cũ).
 *   - Mọi lõi LLM khác (agents + chat + utility + judges fallback) route qua
 *     OPENCODE ZEN (HTTP → CLI → ZEN FAILOVER space-bunny-free → last-resort).
 *
 * Lịch sử đã hồi phục/EOL (giữ làm ghi chú): glm-5.2 (410 2026-08-21),
 *   glm-5.3 (không tồn tại), kimi-k2.6, glm-5.1, minimax-m2.7, qwen3.5-397b
 *
 * FAILOVER ORDER (MODEL TRƯỚC, KEY SAU — giữ từ 2026-09-06 cho các lõi NIM còn sống):
 *   extraction: NIM nemotron-550b xoay vòng 4 key × 3 lần → (fail toàn chuỗi) → chuỗi Zen
 *   agent chọn kimi-k3: NIM kimi-k3 xoay vòng 4 key × 3 lần → (fail toàn chuỗi) → chuỗi Zen
 *   Circuit breaker/model + timeout-strike giúp lõi NIM hang/429 fail NGAY (ms).
 *
 * Key assignment (AUTO mode, least-loaded-first):
 *   - Each document gets a key (0-3, auto-assigned to least-loaded key)
 *   - Key N uses NVIDIA Key N (strict binding for rate limit isolation)
 *   - If Key N is rate-limited/exhausted → fallback to next available key
 *
 * Token tracking: NVIDIA NIM + OpenCode Zen (theo provider của call)
 *
 * (2026-09-27 TASK 33) Z-AI SDK provider gỡ bỏ toàn bộ + (2026-11-30 UPDATE:
 * NIM mở lại 2 NGOẠI LỆ theo user directive — lõi extraction nemotron-550b +
 * lựa chọn agent tạm thời kimi-k3; mô tả đầy đủ ở đầu file). Mọi lõi LLM khác
 * (agents + chat + utility + judges fallback) route qua OPENCODE ZEN
 * (HTTP → CLI → ZEN FAILOVER space-bunny → error, KHÔNG fallback NIM khác).
 */

// ==================== TOKEN EVENT EMITTER (SSE REALTIME) ====================

import { EventEmitter } from 'events'
// FB-P6-R1-B-07 (q-table là lá — chỉ phụ thuộc @/lib/db, không vòng import)
import { getTuningEnum, getTuningNumber } from '@/lib/learning/tuning-store'
// Type-only import (erased lúc runtime — không tạo thêm module instance)
import type { DocumentPayload } from '@/lib/qdrant'
// ROUND-50 (P3-ζ r49 — bằng chứng user 2026-10-06 dán thought content nguyên văn
// `]<]minimax[>[` từ UI): space-bunny-free (model nền MiniMax) leak chat-template
// marker vào content. Strip TẠI NGUỒN mọi response zen để MỌI consumer (thought
// display, final report, arbiter, evaluator, consult parse) nhận content sạch —
// trước đây chỉ tầng parse tool_call strip (r44) nên panel Suy nghĩ + báo cáo
// vẫn dính rác. tool-calls.ts chỉ import find-balanced-json — không cycle.
import { stripProviderGarbleMarkers } from '@/lib/tool-calls'

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
  /** Số reasoning tokens của lượt call (Zen reasoning models — space-bunny
   *  effort max, muse-spark xhigh). Trích từ usage.completion_tokens_details.
   *  reasoning_tokens TRỪ vào max_tokens (cùng pool completion) — caller truyền
   *  budget nhỏ cần chú ý (user directive 2026-09-28: LUÔN max effort + token
   *  không giới hạn → callZenProvider tự bỏ max_tokens khi effort max/xhigh). */
  reasoningTokens?: number
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
  /** TASK D (token efficiency 2026-10-30): true = KHÔNG đính kèm options.tools
   *  vào body.tools của call Zen HTTP dù caller có truyền schemas — dành cho
   *  call path mà model HIỆN TẠI bỏ qua native FC (vd space-bunny-free trả 0
   *  tool_calls, hành động chạy qua text protocol trong system prompt) → bớt
   *  ~7k tokens/vòng schema JSON chết. Undefined/false = hành vi cũ (đính kèm
   *  khi có tools) — MỌI caller khác không đặt cờ này nên không đổi hành vi.
   *  Caller kiểm soát bằng env TMO_GOAL_LOOP_NATIVE_TOOLS. */
  skipNativeTools?: boolean
  /** Phase 4 SMOLAB Prop 11' — explicit model override (e.g. 'moonshotai/kimi-k3').
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
  /** P6-M3 (BLUEPRINT-STATS-LEARNING §P6-M3): số thứ tự chu kỳ ReAct của
   *  call — thành phần seed xác suất softmax "hash(sessionId, cycle)" (cùng
   *  sessionId + cùng chu kỳ → cùng lựa chọn — chạy lại được). Undefined
   *  = 0 (call ngoài chu kỳ — seed theo sessionId). */
  qPolicyCycle?: number
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
  /** TASK 55 (2026-09-28): override reasoning_effort cho Zen reasoning models
   *  (space-bunny: low|medium|high|xhigh|max; muse-spark: low..xhigh).
   *  'none' = KHÔNG gửi reasoning_effort. Undefined = map mặc định theo model
   *  (zenReasoningEffortForModel — agents giữ chế độ cao nhất).
   *  Context: utility call (digest/phân loại/JSON) gửi maxTokens nhỏ (700-2k)
   *  kèm effort=max → reasoning nuốt TOÀN BỘ budget → content rỗng, finish=length,
   *  response 200 OK (đường fail ÂM THẦM duy nhất của callZenProvider — verified
   *  thực nghiệm 28/09: prompt 120k chars + max_effort + mt700 → content '';
   *  cùng prompt + effort low → reasoning chỉ 88 tokens, digest đủ dùng). */
  reasoningEffort?: string
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
    return models // Fixed order: [nemotron-550b] — lõi extraction duy nhất (2026-11-30)
  }
  // AGENT/CHAT models (2026-11-30: chỉ còn kimi-k3 — lựa chọn NIM tạm thời):
  // no rotation — thứ tự cố định, không load-balance.
  if (models === NVIDIA_AGENT_MODELS) {
    return models // Always [kimi-k3] — lựa chọn agent NIM tạm thời (2026-11-30)
  }
  // Legacy lists: rotate as before
  const offset = modelRotationCounters[provider] % models.length
  modelRotationCounters[provider]++
  if (offset === 0) return models // No rotation needed
  return [...models.slice(offset), ...models.slice(0, offset)]
}

/** NVIDIA NIM EXTRACTION models (user directive 2026-11-30 — cập nhật từ 2026-09-05):
 *  CHÍNH SÁCH: trích xuất (triết tách) tài liệu dùng nemotron-3-ultra-550b làm
 *  LÕI CHÍNH DUY NHẤT — KHÔNG BAO GIỜ dùng kimi-k3 cho trích xuất tài liệu.
 *  Khi lõi NIM fail toàn chuỗi xoay key (429 kéo dài — đặc tính NIM với tác vụ
 *  phức tạp/dài) → callLLMSlot fallback chuỗi Zen (EXTRACTION_ZEN_MODEL, mặc
 *  định space-bunny-free) để pipeline trích xuất không chết.
 *
 *  nvidia/nemotron-3-ultra-550b-a55b: 550B MoE (55B active) ✓ ALIVE —
 *    live-probe 2026-11-30 HTTP 200 (4/4 key OK từ matrix 2026-10-16).
 *  openai/gpt-oss-120b (lõi fallback cũ) → ĐÃ LOẠI (HTTP 410 GONE — EOL
 *    2026-09-03, xác nhận live-probe 2026-11-30).
 *
 *  Đã bỏ cũ: llama-3.1-nemotron-ultra-253b-v1, nemotron-4-340b-instruct (404),
 *  meta/llama-3.3-70b-instruct (chất lượng kém hơn 550b), gpt-oss-120b (410).
 */
const NVIDIA_EXTRACTION_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
]

/** NVIDIA NIM AGENT/CHAT models (user directive 2026-11-30):
 *  CHỈ CÒN kimi-k3 — giữ lại như 1 LỰA CHỌN model agent TẠM THỜI ("nếu kimi
 *  k3 sống được thì giữ lại như 1 lựa chọn"). Chọn kimi-k3 trong UI → agent
 *  route THẬT qua NIM kimi-k3; NIM 429 kéo dài/hang → callLLMForAgent tự
 *  fallback chuỗi Zen space-bunny-free (agent không chết).
 *
 *  Live-probe 2026-11-30: kimi-k3 ALIVE nhưng CHẬM (~120s cho prompt tối giản
 *  — verified curl 200 sau 2p0s). Toàn bộ lõi khác ĐÃ LOẠI BỎ theo user
 *  directive ("toàn bộ loại bỏ luôn" — xác nhận 410 EOL live-probe 2026-11-30):
 *    minimaxai/minimax-m3 (EOL 2026-09-09) · deepseek-ai/deepseek-v4-pro-0813
 *    (EOL 2026-09-14) · deepseek-ai/deepseek-v4-flash-0731 (EOL 2026-09-21).
 *  (Lịch sử: minimax-m3 từng là lõi chính tạm thời 2026-10-16 — đã EOL.)
 */
const NVIDIA_AGENT_MODELS = [
  'moonshotai/kimi-k3',
]

/** Kimi K3 NIM id — lựa chọn model agent NIM tạm thời (user directive
 *  2026-11-30). Dùng bởi callLLMForAgent (route NIM thật) + UI/agents
 *  (validation + boot migration phải TÔN TRỌNG giá trị này, không normalize). */
export const KIMI_K3_NIM_ID = 'moonshotai/kimi-k3'

/**
 * KIMI-K3 TIMEOUT RIÊNG (user directive 2026-12-01: "kimi-k3 là siêu model
 * nên chậm là bình thường, dù sao hệ thống được xây dựng để các agents vận
 * hành liên tục hàng tiếng đồng hồ... nên có chậm vài phút tôi chẳng quan
 * tâm").
 *
 * Live 2026-11-30 (task-85 E2E): kimi-k3 ~120s cho prompt tối giản, ~2-6 phút
 * cho agent cycle context lớn (42k token) — call chậm-hợp-lệ bị base timeout
 * 240s (LLM_TIMEOUT_MS) giết giữa chừng → đếm TIMEOUT-STRIKE → breaker trip
 * oan → ép fallback space-bunny-free dù model đang sống. Base timeout riêng
 * cho ĐÚNG KIMI_K3_NIM_ID: 600s (10 phút — dư dả cho 2-6 phút quan sát được;
 * env KIMI_K3_TIMEOUT_MS, floor 60s). Model NIM khác (nemotron-550b
 * extraction ~5s live) giữ LLM_TIMEOUT_MS. Áp dụng tập trung tại
 * callModelWithKeyRotation (mọi đường kimi-k3 — agent callLLMForAgent, judge
 * callLLM override — đều qua đây). Budget xoay key 15' (KEY_ROTATION_BUDGET_MS)
 * giữ nguyên: hang thật vẫn bị cắt trong 15' rồi fallback Zen.
 */
const KIMI_K3_TIMEOUT_MS = Math.max(
  parseInt(process.env.KIMI_K3_TIMEOUT_MS || '600000', 10) || 600_000,
  60_000,
)

/**
 * NVIDIA_MODELS (updated 2026-11-30): = NVIDIA_AGENT_MODELS (1 lõi chat —
 * kimi-k3, lựa chọn NIM tạm thời). nemotron-3-ultra-550b KHÔNG thuộc danh
 * sách này — lõi extraction duy nhất (NVIDIA_EXTRACTION_MODELS).
 * Deprecated (404/410): kimi-k2.6, glm-5.1, minimax-m2.7, qwen3.5-397b,
 * minimax-m3 + cả dòng deepseek (đã loại bỏ toàn bộ 2026-11-30).
 */
// Alias of NVIDIA_AGENT_MODELS — same chat core(s), same failover order.
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
  console.log(`[LLM] NVIDIA (user directive 2026-11-30): embed (embeddings.ts) + extraction nemotron-550b (callLLMSlot NIM-first, fallback Zen) + agent/chat ${NVIDIA_AGENT_MODELS.join(' / ')} (lựa chọn tạm thời — chọn kimi-k3 route NIM thật, fail → Zen space-bunny-free). ĐÃ LOẠI: minimax-m3 + dòng deepseek (410 EOL) + gpt-oss-120b (410 EOL)`)
}

// ==================== NVIDIA KEY ROTATION (giữ từ KIMI K3 POLICY 2026-08-31) ====================
// USER DIRECTIVE 2026-08-31 (còn hiệu lực cho CÁC LÕI NIM ĐANG DÙNG): "mọi
// Agents, mọi tác vụ từ giờ sẽ sử dụng lõi Kimi k3, nếu gặp vấn đề thì chuyển
// API key của NVIDIA NIM, xoay vòng mỗi key 3 đủ 3 lần thì mới dừng lại... tới
// khi chuyển qua cả 4 key lại về key đầu tiên, đến khi mỗi key đều đủ 3 lần
// thì mới dừng lại" — cơ chế xoay key áp cho kimi-k3 (agent) lẫn nemotron-550b
// (extraction).
//
// USER DIRECTIVE 2026-11-30 (MODEL MATRIX MỚI — thay thế chuỗi fallback NIM):
//   - NIM chỉ giữ: embed + nemotron-550b (extraction) + kimi-k3 (lựa chọn agent
//     tạm thời). minimax-m3 + cả dòng deepseek ĐÃ LOẠI BỎ toàn bộ (410 EOL).
//   - Không còn FALLBACK CHAIN NIM (kimi → ds → minimax): khi lõi NIM cạn chuỗi
//     xoay key → fallback sang chuỗi Zen space-bunny-free.
//
// Chính sách xoay key:
//   1. Lõi NIM được gọi (kimi-k3 khi agent chọn / nemotron-550b cho extraction)
//      theo cấu hình — KHÔNG override mọi agent về 1 lõi.
//   2. Khi 1 attempt gặp vấn đề (429 rate-limit, 5xx, 401/403, timeout, network...)
//      → CHUYỂN NGAY sang key kế tiếp: key1→key2→key3→key4→key1→key2→...
//   3. MỖI key được thử tối đa KEY_FAILURES_PER_KEY (3) lần trong 1 chuỗi xoay vòng.
//      Chỉ khi MỌI key đều đã fail đủ 3 lần (4 key × 3 = 12 attempts) mới dừng.
//   4. Extraction pipeline dùng lõi riêng (user directive 2026-09-05 + 2026-11-30):
//      nemotron-3-ultra-550b qua callLLMSlot (NIM-first, fallback chuỗi Zen),
//      TUYỆT ĐỐI không dùng kimi-k3; override bằng env EXTRACTION_MODEL.

/** Lõi model CHÍNH của AGENT STACK (mặc định ZEN — user directive Task 33
 *  2026-09-27: NIM bỏ hoàn toàn khỏi tác vụ agents).
 *
 *  ⚠️ USER DIRECTIVE 2026-10-28 (TASK 37 — CHỐT CHÍNH SÁCH MODEL ZEN PHIÊN 7):
 *  "Thiết lập lại để TẤT CẢ các agent đều sử dụng space-bunny-free" — sau
 *  policy Zen ~25-26/09 (verified thực nghiệm 28/10: HTTP oc_sk key → chỉ
 *  space-bunny-free trả 200; nemotron-3-ultra-free/muse-spark/lightning
 *  đều 403 FreeTierError ở cả 2 key). Toàn bộ 13 agents chạy space-bunny-free
 *  (stealth reasoning, ctx 1M / out 512k, effort max — cao nhất toàn Zen).
 *  Muốn dùng lại model free khác: giờ CHẠY ĐƯỢC qua đường CLI native (r72 —
 *  verified 2026-10-09: auth.json key oc_sk + provider native `opencode`;
 *  llm.ts tự route, KHÔNG cần thao tác gì thêm).
 *  máy chạy app + đường OpenCode CLI — xem callOpenCodeCLIProvider.
 *    - ZEN FAILOVER (model dự phòng khi model chính fail cả HTTP + CLI) = space-bunny-free
 *
 *  AGENT_PRIMARY_MODEL ở đây = bậc 0 của stack dùng cho model-switch (research
 *  team DR-C7) + hiển thị health — KHÔNG còn ý nghĩa "override mọi agent về 1
 *  lõi" (callLLMForAgent giờ tôn trọng model zen cấu hình từng agent).
 *  Override qua env: AGENT_PRIMARY_MODEL (đặt rỗng/bỏ trong .env để dùng mặc định).
 */
export const AGENT_PRIMARY_MODEL =
  process.env.AGENT_PRIMARY_MODEL?.trim() || 'space-bunny-free'

/** @deprecated alias — giữ cho các import cũ; ngữ nghĩa "lõi chính của stack". */
export const KIMI_K3_MODEL = AGENT_PRIMARY_MODEL

/** Chuỗi fallback ZEN của agent stack (bậc 1-3 — dùng cho model-switch DR-C7
 *  research team + hiển thị; runtime failover thật của callLLMForAgent là
 *  HTTP → CLI → ZEN FAILOVER space-bunny, không phải chuỗi này).
 *  Task 33 (2026-09-27): chuyển từ chuỗi NIM (kimi/deepseek/minimax) sang chuỗi
 *  zen thuần — NIM không còn dùng cho agents. */
export const AGENT_FALLBACK_CHAIN: string[] = (() => {
  const csv = process.env.AGENT_FALLBACK_CHAIN?.trim()
  if (csv) {
    const parsed = csv.split(',').map(s => s.trim()).filter(Boolean)
    if (parsed.length > 0) return parsed
  }
  return [
    'nemotron-3.5-lightning-free',
    'mimo-v2.6-flash-free',
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

/** (TASK 33 — 2026-09-27) isKimiK3Enforced ĐÃ GỠ: chính sách override mọi agent
 *  về 1 lõi NIM chung không còn tồn tại — agents dùng đúng model zen cấu hình
 *  riêng (DB AgentProfile), runtime chỉ còn đường Zen (HTTP → CLI → failover). */

/** (2026-11-30) Chuỗi backup cores NIM deepseek/minimax đã EOL TOÀN BỘ — loại
 *  bỏ khỏi matrix. callAgentModelWithFallbackChain() giờ là legacy không-caller
 *  (chain zen bên trong); runtime thật = callLLMForAgent (Zen + nhánh kimi-k3 NIM). */

/**
 * [LEGACY — KHÔNG còn caller từ Task 33 (giữ làm tư liệu]: gọi lõi agent theo
 * chuỗi MODEL-FIRST (directive 2026-09-06 — chuỗi kimi-k3 → ds-pro → ds-flash
 * → minimax-m3 đã EOL toàn bộ 2026-11-30). Chain hiện tại = AGENT_PRIMARY_MODEL
 * (space-bunny-free) + AGENT_FALLBACK_CHAIN (zen) — mô tả ở section phía trên.
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
    // FIX (FB-P1-R1-04, 2026-10-10): thêm 410 — NIM decommission model VĨNH
    // VIỄN (glm-5.2 EOL 2026-08-21, gpt-oss-120b GONE 2026-10-16, deepseek-v4-
    // flash GONE 2026-10-10 — eval runner quan sát live): 410 rơi vào
    // 'server_error' → sweep 12 attempts NHANH (~0.1s/attempt) không bao giờ
    // cạn budget thiết kế cho timeout 240s → vòng cooldown 15s lặp VÔ HẠN,
    // eval run treo vĩnh viễn ở case đầu (18+ phút 0/3, bằng chứng
    // cmv29082p0012navrlnwlec1v). 410 deterministic theo model — key khác
    // retry cùng model-name cũng 410 y hệt như 404.
    const isDeterministic4xx = response.status === 400 || response.status === 404 || response.status === 410 || response.status === 413 || response.status === 414 || response.status === 422 || response.status === 431
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

// TASK 33 (2026-09-27): default OFF. 2026-11-30 UPDATE: NIM mở lại 2 vai trò
// (extraction nemotron-550b + agent kimi-k3 tạm thời) → prober giờ probe ĐÚNG
// các lõi NIM đang dùng (probeTargets bên dưới). Bật bằng LLM_MODEL_PROBER=true
// để trip breaker nền cho lõi hang thật (0-byte). Lưu ý 2026-12-01: kimi-k3
// chậm ~120s/call là trạng thái BÌNH THƯỜNG (siêu model — user directive
// "chậm là bình thường... có chậm vài phút tôi chẳng quan tâm"), KHÔNG phải
// hang → probe kimi-k3 dùng floor 300s (probeTimeoutFor) để không trip oan.
const PROBER_ENABLED = (process.env.LLM_MODEL_PROBER ?? '0').trim().toLowerCase() === 'true'
const PROBE_INTERVAL_MS = Math.max(60_000, parseInt(process.env.LLM_PROBE_INTERVAL_MS || '300000', 10) || 300_000)
const PROBE_TIMEOUT_MS = Math.max(10_000, parseInt(process.env.LLM_PROBE_TIMEOUT_MS || '90000', 10) || 90_000)
const PROBER_BOOT_DELAY_MS = Math.max(0, parseInt(process.env.LLM_PROBER_BOOT_DELAY_MS || '30000', 10) || 30_000)

/** Các lõi NIM được probe (2026-11-30): kimi-k3 (lựa chọn agent tạm thời) +
 *  nemotron-550b (extraction). Các lõi zen trong AGENT_FALLBACK_CHAIN không
 *  probe được qua NIM pool — bỏ khỏi danh sách (chúng có block-cache riêng). */
function probeTargets(): string[] {
  const targets = [
    KIMI_K3_NIM_ID,
    EXTRACTION_MODEL_OVERRIDE || NVIDIA_EXTRACTION_MODELS[0],
  ]
  return [...new Set(targets)]
}

/** Probe timeout theo model — kimi-k3 chậm-hợp-lệ ~120s/call (live
 *  2026-11-30; directive 2026-12-01 "chậm là bình thường") nên probe 90s
 *  mặc định sẽ trip breaker oan model đang sống. Floor riêng 300s cho đúng
 *  KIMI_K3_NIM_ID (env KIMI_K3_PROBE_TIMEOUT_MS); model khác giữ
 *  PROBE_TIMEOUT_MS (nemotron-550b ~5s live — 90s dư dả). */
function probeTimeoutFor(model: string): number {
  return model === KIMI_K3_NIM_ID
    ? Math.max(PROBE_TIMEOUT_MS, parseInt(process.env.KIMI_K3_PROBE_TIMEOUT_MS || '300000', 10) || 300_000)
    : PROBE_TIMEOUT_MS
}

/** Probe 1 model bằng request nhỏ. Trả về 'ok' | 'hang' | 'skip' (transient). */
async function probeModelOnce(model: string, slot: number): Promise<'ok' | 'hang' | 'skip'> {
  const pool = nvidiaPool
  // Key theo slot (0..3) — getKeyByIndex tự fallback sang key khả dụng kế
  // khi slot rỗng/rate-limited; hết key → skip cycle này (fail-open).
  const keyInfo = pool.getKeyByIndex(slot % MAX_KEYS)
  if (!keyInfo || !keyInfo.key) return 'skip'
  const startedAt = Date.now()
  const probeTimeoutMs = probeTimeoutFor(model)
  let attempt: Awaited<ReturnType<typeof attemptNvidiaOnce>>
  try {
    attempt = await attemptNvidiaOnce({
      keyInfo: { key: keyInfo.key, keyIndex: keyInfo.keyIndex },
      model,
      prompt: 'Health probe — reply with exactly: OK',
      systemPrompt: undefined,
      temperature: 0,
      maxTokens: 16,
      timeoutMs: probeTimeoutMs,
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
      `PROBE HANG: request nhỏ (16 token) chờ ${Math.round(probeTimeoutMs / 1000)}s vẫn 0 bytes — model HANG phía NVIDIA NIM (model khác cùng key vẫn chạy = sự cố model-level, không phải key/network). Prober sẽ tự mở lại khi model hồi phục (probe mỗi ${Math.round(PROBE_INTERVAL_MS / 60000)} phút).`,
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
  // USER DIRECTIVE 2026-12-01: kimi-k3 chậm-hợp-lệ (2-6 phút/call) là bình
  // thường — base timeout riêng 600s cho đúng KIMI_K3_NIM_ID thay vì 240s
  // chung (đ anti trip-breaker oan; xem KIMI_K3_TIMEOUT_MS phía trên).
  const timeoutMs = scaleTimeoutByMaxTokens(
    rotationOpts?.timeoutMs
      ?? (model === KIMI_K3_NIM_ID
        ? KIMI_K3_TIMEOUT_MS
        : parseInt(process.env.LLM_TIMEOUT_MS || '240000', 10)),
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
 * Key-based LLM call for document processing — EXTRACTION CORE ONLY
 * (user directive 2026-11-30):
 *   1. PRIMARY:  NIM nvidia/nemotron-3-ultra-550b-a55b — xoay vòng 4 key × 3 lần
 *   2. FALLBACK: chuỗi Zen (EXTRACTION_ZEN_MODEL — HTTP → CLI → ZEN FAILOVER)
 *                khi NIM fail toàn chuỗi (429 kéo dài — đặc tính NIM với tác vụ
 *                phức tạp/dài hạn theo user).
 *
 * KHÔNG BAO GIỜ gọi kimi-k3 (lõi agent/chat) cho extraction — đây là ràng
 * buộc cứng theo directive user (2026-09-05, giữ nguyên 2026-11-30).
 * (Lõi fallback NIM cũ gpt-oss-120b đã EOL 410 — loại bỏ.)
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

  // ===== USER DIRECTIVE 2026-11-30 — EXTRACTION NIM-FIRST =====
  // "Tôi chỉ sử dụng lõi embed từ Nvidia Nim và nemotron-3-ultra-550b cho công
  // việc triết tách" — nemotron-3-ultra-550b quay lại làm lõi extraction CHÍNH
  // (NIM 4 key xoay vòng, circuit breaker + timeout-strike tự trip khi NIM
  // hang/429). NIM dễ 429 kéo dài với tác vụ phức tạp/dài → khi lõi NIM fail
  // toàn chuỗi xoay key, fallback chuỗi Zen (EXTRACTION_ZEN_MODEL, mặc định
  // space-bunny-free) để pipeline trích xuất không chết.
  // kimi-k3 TUYỆT ĐỐI không dùng cho extraction (directive 2026-09-05 giữ nguyên).
  // slotIndex (document key assignment cũ) giữ làm startKeyIndex gợi ý xoay key.
  const nimExtractionModel = EXTRACTION_MODEL_OVERRIDE || NVIDIA_EXTRACTION_MODELS[0]
  if (nvidiaPool.keyCount > 0 && nimExtractionModel && !isModelHardBlocked(nimExtractionModel).blocked) {
    const nimResult = await callModelWithKeyRotation(
      nimExtractionModel,
      prompt,
      systemPrompt,
      options,
      {
        taskLabel: `extraction-nim:${taskLabel}`,
        startKeyIndex: slotIndex >= 0 ? slotIndex : undefined,
        temperature: options?.temperature ?? 0.1,
        maxTokens: options?.maxTokens ?? 16384,
      },
    )
    if (nimResult && nimResult.content) {
      console.log(`[LLM] Extraction dùng NIM ${nimExtractionModel} ✓ (${nimResult.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return nimResult
    }
    console.warn(`[LLM] Extraction NIM ${nimExtractionModel} thất bại toàn chuỗi xoay key — fallback chuỗi Zen — task: ${taskLabel}: ${String(nimResult?.error || 'null result').slice(0, 120)}`)
  }

  // ===== EXTRACTION FALLBACK — OPENCODE ZEN (giữ từ Task 33) =====
  // NIM 429 kéo dài / hết key / breaker mở → chuỗi Zen: HTTP → CLI → ZEN
  // FAILOVER space-bunny. Override EXTRACTION_ZEN_MODEL để đổi model zen.
  if (isZenConfigured()) {
    const extractModel = process.env.EXTRACTION_ZEN_MODEL?.trim() || 'space-bunny-free'
    const zen = await callZenProvider(
      prompt,
      systemPrompt,
      extractModel,
      { ...options, temperature: options?.temperature ?? 0.1, maxTokens: options?.maxTokens ?? 16384 },
      `extraction:${taskLabel}`,
    )
    if (zen && zen.content) {
      console.log(`[LLM] Extraction dùng Zen ${extractModel} ✓ (${zen.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return zen
    }
    console.warn(`[LLM] Extraction Zen HTTP ${extractModel} thất bại — thử OpenCode CLI: ${(zen?.error || 'unknown').slice(0, 100)}`)
    const cliResult = await callOpenCodeCLIProvider(
      prompt,
      systemPrompt,
      extractModel,
      { ...options, temperature: options?.temperature ?? 0.1, maxTokens: options?.maxTokens ?? 16384 },
      `extraction:${taskLabel}`,
    )
    if (cliResult && cliResult.content) {
      console.log(`[LLM] Extraction dùng OpenCode CLI ${extractModel} ✓ (${cliResult.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return cliResult
    }
    const zenFailoverModel = process.env.ZEN_FAILOVER_MODEL?.trim() || 'space-bunny-free'
    if (extractModel !== zenFailoverModel) {
      console.warn(`[LLM] Extraction Zen ${extractModel} thất bại cả HTTP + CLI — thử ZEN FAILOVER ${zenFailoverModel} — task: ${taskLabel}`)
      const foHttp = await callZenProvider(prompt, systemPrompt, zenFailoverModel, { ...options, temperature: options?.temperature ?? 0.1, maxTokens: options?.maxTokens ?? 16384 }, `extraction-failover:${taskLabel}`)
      if (foHttp && foHttp.content) {
        console.log(`[LLM] Extraction dùng ZEN FAILOVER ${zenFailoverModel} ✓ — task: ${taskLabel}`)
        return foHttp
      }
    }
    console.warn(`[LLM] Extraction "${taskLabel}": cả NIM ${nimExtractionModel} lẫn chuỗi Zen đều thất bại — document sẽ retry sau`)
    return {
      content: '',
      provider: 'zen',
      model: extractModel,
      error: `Extraction "${taskLabel}" thất bại toàn bộ (NIM ${nimExtractionModel} + Zen ${extractModel} HTTP + CLI${extractModel !== zenFailoverModel ? ` + failover ${zenFailoverModel}` : ''})`,
    }
  }

  console.warn(`[LLM] Extraction "${taskLabel}": NIM thất bại và Zen chưa cấu hình (set ZEN_API_KEY_1/2 trong .env)`)
  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: `Extraction "${taskLabel}": NIM ${nimExtractionModel} thất bại và OpenCode Zen chưa cấu hình (set ZEN_API_KEY_1/2 trong .env)`,
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
 * CHÍNH SÁCH (2026-11-30): utility nền KHÔNG dùng lõi NIM (NIM dễ 429 kéo dài
 * với tác vụ nền dài — chỉ dành embed + extraction + kimi-k3 agent tạm thời).
 * Utility route qua chuỗi Zen (UTILITY_ZEN_MODEL, mặc định space-bunny-free).
 * Lịch sử: trước đây dùng chuỗi extraction NIM nemotron→gpt-oss (directive
 * 2026-09-06) — gpt-oss đã EOL 410, NIM giờ ưu tiên cho extraction chính.
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
  //
  // TASK 55 (2026-09-28): mặc định ĐỔI nemotron-3.5-lightning-free →
  // space-bunny-free. Lý do: nemotron-lightning 403 FreeTierError VĨNH VIỄN
  // với oc_sk key (verified 28/10 — chỉ space-bunny-free còn mở API) → 100%
  // utility call rơi xuống failover. Cộng thêm failover chạy effort=max (map
  // mặc định) kèm maxTokens nhỏ của caller (compression 700) → reasoning nuốt
  // hết budget → content rỗng → TOÀN BỘ utility LLM fail-open âm thầm
  // (compression LLM 0/15 thành công — heuristic cứu). Giờ: model chính =
  // space-bunny + effort='low' (tác vụ cơ khí — verified: prompt 120k chars,
  // reasoning chỉ 88 tokens, digest đủ dùng, nhanh gấp ~2-4x effort max).
  // Override qua env UTILITY_ZEN_MODEL (đặt model khác nếu policy Zen đổi).
  if (isZenConfigured() && !options?.skipZenUtility) {
    const utilModel = process.env.UTILITY_ZEN_MODEL || 'space-bunny-free'
    // USER DIRECTIVE 2026-09-28 (phiên sau Task 55): space-bunny LUÔN effort
    // MAX ở MỌI đường (agents + utility) — bỏ ép 'low' của Task 55. Chống
    // reasoning starvation giờ do callZenProvider tự lo (anti-starvation
    // guard: effort max/xhigh + max_tokens nhỏ → bỏ giới hạn output). Caller
    // truyền reasoningEffort rõ ràng ('none'/'low'...) vẫn được tôn trọng.
    const utilOptions: LLMCallOptions = {
      ...options,
    }
    let zen = await callZenProvider(prompt, systemPrompt, utilModel, utilOptions, `utility-core:${taskLabel}`)
    // ROUND-5 FIX (2026-09-29 — quan sát vận hành vòng 5, mirror agent path):
    // HTTP 5xx là lỗi TẠM THỜI (provider quá tải thoáng qua) — retry 1 lần
    // với key kế trước khi chuyển chuỗi. KHÔNG retry lỗi thời gian ở đường
    // utility (timeout đã dài theo input — caller fail-open nhanh hơn là
    // chờ thêm 1 chuỗi; 5xx fail nhanh nên retry rẻ). Bằng chứng
    // cùng cửa sổ vận hành: chu kỳ 14 SENTINEL chết sau 1 lần HTTP 503.
    if (zen && !zen.content
        && /HTTP 5\d\d|Zen empty response/i.test(zen.error ?? '')) {
      // ROUND-7: thêm empty-response (reasoning starvation) — mirror fix agent
      // path; utility (compression/evaluator) starvation từng làm compression
      // LLM fail 15/15 lần (TASK 55 evidence).
      const isEmptyResponse = /Zen empty response/i.test(zen.error ?? '')
      const retryOpts = isEmptyResponse && !utilOptions?.reasoningEffort
        ? { ...utilOptions, reasoningEffort: 'high' }
        : utilOptions
      console.warn(`[LLM] Utility-core Zen ${utilModel} ${isEmptyResponse ? 'reasoning starvation (0 content)' : 'HTTP 5xx'} (lần 1) — retry 1 lần${isEmptyResponse ? ' effort→high' : ' key kế'} — task: ${taskLabel}: ${String(zen.error).slice(0, 100)}`)
      zen = await callZenProvider(prompt, systemPrompt, utilModel, retryOpts, `utility-core-retry:${taskLabel}`)
    }
    if (zen && zen.content) {
      console.log(`[LLM] Utility-core dùng Zen ${utilModel} ✓ (${zen.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return zen
    }
    console.warn(`[LLM] Utility-core Zen HTTP ${utilModel} thất bại — thử OpenCode CLI: ${(zen?.error || 'unknown').slice(0, 100)}`)
    const cliResult = await callOpenCodeCLIProvider(prompt, systemPrompt, utilModel, utilOptions, `utility-core:${taskLabel}`)
    if (cliResult && cliResult.content) {
      console.log(`[LLM] Utility-core dùng OpenCode CLI ${utilModel} ✓ (${cliResult.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return cliResult
    }
    // TASK 33 — ZEN FAILOVER cho utility-core (mirror callLLMForAgent)
    const zenFailoverModel = process.env.ZEN_FAILOVER_MODEL?.trim() || 'space-bunny-free'
    if (utilModel !== zenFailoverModel) {
      console.warn(`[LLM] Utility-core Zen ${utilModel} thất bại cả HTTP + CLI — thử ZEN FAILOVER ${zenFailoverModel} — task: ${taskLabel}`)
      const foHttp = await callZenProvider(prompt, systemPrompt, zenFailoverModel, utilOptions, `utility-core-failover:${taskLabel}`)
      if (foHttp && foHttp.content) {
        console.log(`[LLM] Utility-core dùng ZEN FAILOVER ${zenFailoverModel} ✓ — task: ${taskLabel}`)
        return foHttp
      }
    }
    console.warn(`[LLM] Utility-core "${taskLabel}": Zen thất bại toàn chuỗi — caller sẽ fail-open (NIM removed — Task 33)`)
    return {
      content: '',
      provider: 'zen',
      model: utilModel,
      error: `Utility-core "${taskLabel}" thất bại toàn chuỗi Zen (${utilModel} HTTP + CLI${utilModel !== zenFailoverModel ? ` + failover ${zenFailoverModel}` : ''}) — NIM đã ngừng dùng cho LLM (Task 33)`,
    }
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

  // Zen chưa cấu hình — trả lỗi rõ ràng (utility là fail-open: caller tự bỏ qua)
  console.warn(`[LLM] Utility "${taskLabel}": Zen chưa cấu hình — NIM đã gỡ (Task 33)`)
  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: 'OpenCode Zen chưa cấu hình (set ZEN_API_KEY_1/2 trong .env) — utility không còn đường NIM (Task 33)',
  }
}

/**
 * Legacy LLM call — giờ route qua OPENCODE ZEN (Task 33 — NIM đã gỡ khỏi
 * tác vụ agents/utility; NIM chỉ còn lõi embed). Chuỗi: (model override nếu
 * có) → Zen HTTP → OpenCode CLI → ZEN FAILOVER space-bunny → error.
 * Use this for non-extraction tasks (chat queries, classification, health checks).
 */
export async function callLLM(
  prompt: string,
  systemPrompt?: string,
  task?: string,
  options?: LLMCallOptions
): Promise<LLMResult> {
  const taskLabel = task || 'general'
  console.log(`[LLM] Task: ${taskLabel}, Prompt: ${prompt.slice(0, 80)}...`)

  // Phase 4 SMOLAB Prop 11' — explicit model override: try ONLY the requested
  // model. Used by the eval harness (judges must not silently fall back to a
  // rotated model — that would reintroduce circular bias between the answer
  // generator and the judges). Model zen → qua Zen provider; model NIM → xoay
  // vòng key NIM (eval tool tự cấu hình key riêng).
  if (options?.model) {
    if (isZenModelId(options.model) && isZenConfigured()) {
      const zenOverride = await callZenProvider(prompt, systemPrompt, options.model, options, `override:${options.model}`)
      if (zenOverride && zenOverride.content) return zenOverride
    }
    const specific = await callModelWithKeyRotation(options.model, prompt, systemPrompt, options, { taskLabel: `override:${options.model}` })
    if (specific) return specific
    console.log(`[LLM] Model override "${options.model}" failed for task "${taskLabel}" — returning error (no rotation fallback)`)
    return {
      content: '',
      provider: 'none',
      model: options.model,
      error: `Model "${options.model}" failed`,
    }
  }

  // ===== OPENCODE ZEN UTILITY PATH (FIX 2026-09-25 — E2E tool audit) =====
  // decompose_task/summarize/synthesize và các utility callLLM() trước đây chỉ có
  // đường NIM (key placeholder chết) → mất ~60s rồi trả content rỗng
  // ("LLM did not return valid JSON" / summary:""). Giờ route qua Zen HTTP →
  // OpenCode CLI (cùng chuỗi callLLMForAgent dùng).
  // TASK 55 (2026-09-28): model utility mặc định ĐỔI nemotron-3.5-lightning-free →
  // space-bunny-free + effort 'low' — xem giải thích đầy đủ ở callUtilityLLM
  // (nemotron 403 vĩnh viễn; failover effort=max + maxTokens nhỏ = rỗng).
  // Override qua env UTILITY_ZEN_MODEL. skipZenUtility: caller đã thử zen xong.
  if (isZenConfigured() && !options?.skipZenUtility) {
    const utilModel = process.env.UTILITY_ZEN_MODEL || 'space-bunny-free'
    // USER DIRECTIVE 2026-09-28: bỏ ép effort 'low' của Task 55 — space-bunny
    // LUÔN max effort; chống reasoning starvation do callZenProvider đảm nhiệm
    // (bỏ max_tokens khi effort max/xhigh). Override qua env UTILITY_ZEN_MODEL.
    // skipZenUtility: caller đã thử zen xong.
    const utilOptions: LLMCallOptions = {
      ...options,
    }
    let zen = await callZenProvider(prompt, systemPrompt, utilModel, utilOptions, `utility:${taskLabel}`)
    // ROUND-7: retry empty-response/5xx 1 lần — mirror utility-core + agent path
    // (reasoning starvation từng giết 15/15 compression call — TASK 55).
    if (zen && !zen.content
        && /HTTP 5\d\d|Zen empty response/i.test(zen.error ?? '')) {
      const isEmptyResponse = /Zen empty response/i.test(zen.error ?? '')
      const retryOpts = isEmptyResponse && !utilOptions?.reasoningEffort
        ? { ...utilOptions, reasoningEffort: 'high' }
        : utilOptions
      console.warn(`[LLM] Utility Zen ${utilModel} ${isEmptyResponse ? 'reasoning starvation (0 content)' : 'HTTP 5xx'} (lần 1) — retry 1 lần${isEmptyResponse ? ' effort→high' : ' key kế'} — task: ${taskLabel}: ${String(zen.error).slice(0, 100)}`)
      zen = await callZenProvider(prompt, systemPrompt, utilModel, retryOpts, `utility-retry:${taskLabel}`)
    }
    if (zen && zen.content) {
      console.log(`[LLM] Utility dùng Zen ${utilModel} ✓ (${zen.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return zen
    }
    console.warn(`[LLM] Utility Zen HTTP ${utilModel} thất bại — thử OpenCode CLI: ${(zen?.error || 'unknown').slice(0, 100)}`)
    const cliResult = await callOpenCodeCLIProvider(prompt, systemPrompt, utilModel, utilOptions, `utility:${taskLabel}`)
    if (cliResult && cliResult.content) {
      console.log(`[LLM] Utility dùng OpenCode CLI ${utilModel} ✓ (${cliResult.tokensUsed ?? 0} tokens) — task: ${taskLabel}`)
      return cliResult
    }
    // TASK 33 — ZEN FAILOVER cho utility (mirror callLLMForAgent): model utility
    // chính fail cả HTTP + CLI → thử space-bunny trước khi trả lỗi.
    const zenFailoverModel = process.env.ZEN_FAILOVER_MODEL?.trim() || 'space-bunny-free'
    if (utilModel !== zenFailoverModel) {
      console.warn(`[LLM] Utility Zen ${utilModel} thất bại cả HTTP + CLI — thử ZEN FAILOVER ${zenFailoverModel} — task: ${taskLabel}`)
      const foHttp = await callZenProvider(prompt, systemPrompt, zenFailoverModel, utilOptions, `utility-failover:${taskLabel}`)
      if (foHttp && foHttp.content) {
        console.log(`[LLM] Utility dùng ZEN FAILOVER ${zenFailoverModel} ✓ — task: ${taskLabel}`)
        return foHttp
      }
      const foCli = await callOpenCodeCLIProvider(prompt, systemPrompt, zenFailoverModel, utilOptions, `utility-failover:${taskLabel}`)
      if (foCli && foCli.content) {
        console.log(`[LLM] Utility dùng ZEN FAILOVER (CLI) ${zenFailoverModel} ✓ — task: ${taskLabel}`)
        return foCli
      }
    }
    console.warn(`[LLM] Utility Zen thất bại toàn chuỗi (HTTP + CLI${utilModel !== (process.env.ZEN_FAILOVER_MODEL?.trim() || 'space-bunny-free') ? ' + failover' : ''}) — trả lỗi (NIM removed — Task 33) — task: ${taskLabel}`)
    return {
      content: '',
      provider: 'zen',
      model: utilModel,
      error: `Utility "${taskLabel}" thất bại toàn chuỗi Zen (${utilModel} HTTP + CLI + failover) — NIM đã ngừng dùng cho LLM (Task 33)`,
    }
  }

  // Zen chưa cấu hình (không có ZEN_API_KEY nào) — trả lỗi rõ ràng
  return {
    content: '',
    provider: 'none',
    model: 'none',
    error: 'OpenCode Zen chưa cấu hình (set ZEN_API_KEY_1/2 trong .env) — NIM đã ngừng dùng cho LLM (Task 33), chỉ còn vai trò lõi embed',
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
/**
 * ROUND-54 FIX D — timeout heuristic TỰ HIỆU CHUẨN theo usage thật.
 * Bằng chứng r54 (mission SENTINEL sub_1791357836734): est chars/4 đo ~147k
 * input tokens trong khi usage thật 312k prompt_tokens (tỷ lệ thực ~2.1
 * chars/token cho transcript JSON-dense) → timeout giãn KHÔNG ĐỦ chiều thực →
 * call bị abort "This operation was aborted" giữa vòng (mất call, retry đắt).
 * Sau mỗi call thành công, ghi nhận tỷ lệ chars/prompt_token THẬT (EMA
 * α=0.25, sanity 1.5–8 — ngoài khoảng bỏ qua chống nhiễu usage thiếu/trắng);
 * call kế ước lượng theo tỷ lệ đã hiệu chuẩn thay vì hằng số 4 (mặc định khi
 * chưa có dữ liệu — call ĐẦU giữ hành vi cũ, từ call 2 trở đi chuẩn dần).
 */
let zenCharsPerTokenEma: number | null = null
function recordZenCharsPerToken(chars: number, promptTokens?: number | null): void {
  try {
    if (!promptTokens || promptTokens <= 0 || chars <= 0) return
    const ratio = chars / promptTokens
    if (!Number.isFinite(ratio) || ratio < 1.5 || ratio > 8) return
    zenCharsPerTokenEma = zenCharsPerTokenEma == null ? ratio : zenCharsPerTokenEma * 0.75 + ratio * 0.25
  } catch { /* fail-open — hiệu chuẩn không được phép ảnh hưởng call */ }
}

// Auth: Bearer token (ZEN_API_KEY_1..4 — multi-key rotation pool; user bổ sung
// key thứ 3 ngày 2026-10-29: "3 API key Zen → tối đa 3 sub-agent song song,
// mỗi sub-agent 1 key riêng — không dùng chung API key")
//
// Free models used by TMO agents (PHIÊN 7 — user directive 2026-10-28, Task 37):
//   - space-bunny-free  (stealth reasoning, ctx 1M / out 512k, effort max)
//     → TẤT CẢ 13 agents (Omega, Opus, ALISTA + 5 code team + 5 research team)
//     — model free DUY NHẤT còn mở cho oc_sk API key sau policy Zen ~25-26/09
//     (verified 28/10: nemotron-ultra/muse-spark/lightning → 403 FreeTierError)
//   - Muốn dùng lại nemotron-3-ultra-free / muse-spark-1.3-contributor-free:
//     đường OpenCode CLI native dưới (r72 — verified 2026-10-09 chạy được với
//     chính key oc_sk, không cần oauth).
//
// Routing: callLLMForAgent checks provider==='zen' BEFORE model-first policy
// → zen-routed agents use their configured model. Chuỗi failover runtime:
//   Zen HTTP → OpenCode CLI (oauth) → ZEN FAILOVER (space-bunny-free).
//
// Known caveats (verified 2026-09-24):
//   - Free models = limited-time promotion, fair-use soft limits (not truly unlimited)
//   - GitHub issue #38028 (Jul 2026): nemotron-3-ultra-free + muse-spark free
//     had transient HTTP 500 failures → NIM fallback chain is mandatory safety net.

const ZEN_BASE_URL = process.env.ZEN_BASE_URL?.trim() || 'https://opencode.ai/zen/v1'
const ZEN_API_KEYS: string[] = [
  process.env.ZEN_API_KEY_1?.trim() || '',
  process.env.ZEN_API_KEY_2?.trim() || '',
  process.env.ZEN_API_KEY_3?.trim() || '',
  process.env.ZEN_API_KEY_4?.trim() || '',
].filter(k => k.length > 0)

let zenKeyIndex = 0
// Per-key 429 cooldown timestamp (0 = not rate-limited)
const zenKey429Until: number[] = ZEN_API_KEYS.map(() => 0)

// ==================== ZEN KEY BINDING — SUB-AGENT 1 KEY/AGENT (user 2026-10-29b) ====================
// USER DIRECTIVE: "tối đa 3 subagents, nếu gọi subagents thì KHÔNG được sử
// dụng cùng API [key]". Mỗi sub-agent chạy bên trong runWithZenKeyBinding(i)
// → MỌI LLM call trong cây async của nó (loop ReAct + wrap-up + trọng tài
// đánh giá độc lập + consult Omega...) đều GHIM key #i qua AsyncLocalStorage
// (không cần xuyên mảng options qua từng tầng call). Key đang bị ghim bởi
// sub-agent nào đó sẽ bị getZenKey() BỎ QUA khi chọn key cho caller thường
// (parent goal-loop / utility) — hết key sạch mới fail-open round-robin.
import { AsyncLocalStorage } from 'node:async_hooks'

const zenKeyBindingStorage = new AsyncLocalStorage<{ keyIndex: number }>()
/** Các key index đang bị sub-agent ghim (0-based) */
const activeZenKeyBindings = new Set<number>()

/** Số key Zen đã cấu hình (1..4) — subagent-delegate dùng để tính số slot. */
export function getZenKeyCount(): number {
  return ZEN_API_KEYS.length
}

/**
 * Chạy fn trong binding ghim key #keyIndex (0-based). Mọi callZenProvider /
 * callOpenCodeCLIProvider bên trong dùng key này thay vì round-robin. Register
 * vào activeZenKeyBindings để getZenKey() của caller thường né key đang bận.
 * Fail-safe: fn throw → finally unregister (binding không rò rỉ).
 */
export async function runWithZenKeyBinding<T>(keyIndex: number, fn: () => Promise<T>): Promise<T> {
  activeZenKeyBindings.add(keyIndex)
  try {
    return await zenKeyBindingStorage.run({ keyIndex }, fn)
  } finally {
    activeZenKeyBindings.delete(keyIndex)
  }
}

/** Lấy key đang ghim bởi async context hiện tại (nếu có) — nội bộ llm.ts.
 * r71 (BUG2-020c): key ghim đang 429-cooldown → trả NULL để callZenProvider
 * rơi xuống getZenKey() (ưu tiên key khỏe chưa bị ghim). Bằng chứng r70:
 * sub-agent slot #1 ghim key #1 — key #1 429 FreeUsageLimitError dai dẳng
 * (17:23→17:31Z) trong khi key #2/#3 hoàn toàn khỏe — getBoundZenKey cũ
 * trả key chết bất chấp cooldown → sub-agent dập lại key chết mỗi retry
 * (65s×2) rồi chết nhãn error. Chia sẻ key khỏe lúc key riêng chết còn
 * hơn chết chờ (user directive r71: "key này 429 thì đổi key khác"). */
function getBoundZenKey(): { key: string; index: number } | null {
  const b = zenKeyBindingStorage.getStore()
  if (!b || b.keyIndex < 0 || b.keyIndex >= ZEN_API_KEYS.length) return null
  if (!boundZenKeyUsable(b.keyIndex, zenKey429Until, Date.now())) return null // key ghim đang cooldown → thoát ghim
  return { key: ZEN_API_KEYS[b.keyIndex], index: b.keyIndex }
}

/** Async-context đang chạy trong runWithZenKeyBinding nhưng key ghim đã bị
 * bỏ qua vì 429? (chỉ dùng cho log 1 lần mỗi call — không ảnh hưởng luồng) */
function hasAbandonedZenBinding(): boolean {
  const b = zenKeyBindingStorage.getStore()
  return !!b && b.keyIndex >= 0 && b.keyIndex < ZEN_API_KEYS.length && zenKey429Until[b.keyIndex] > Date.now()
}

/** Zen is ready to serve calls (at least 1 key configured). */
function isZenConfigured(): boolean {
  return ZEN_API_KEYS.length > 0
}

/**
 * Pick next available Zen key: round-robin, bỏ qua key bị 429-cooldown VÀ key
 * đang bị sub-agent ghim (user directive: sub-agent không dùng chung key với
 * ai khác). Hết lựa chọn sạch → fail-open: chọn key reset sớm nhất (không bao
 * giờ block caller thường — parent/utility vẫn chạy dù mọi key đang ghim).
 */
function getZenKey(): { key: string; index: number } | null {
  if (ZEN_API_KEYS.length === 0) return null
  const now = Date.now()
  // Lượt 1 — key sạch hoàn toàn (không 429, không bị ghim)
  for (let i = 0; i < ZEN_API_KEYS.length; i++) {
    const idx = (zenKeyIndex + i) % ZEN_API_KEYS.length
    if (zenKey429Until[idx] <= now && !activeZenKeyBindings.has(idx)) {
      zenKeyIndex = (idx + 1) % ZEN_API_KEYS.length
      return { key: ZEN_API_KEYS[idx], index: idx }
    }
  }
  // Lượt 2 — key chỉ bị ghim (chưa 429): tạm dùng chung còn hơn chết chờ
  // (chỉ xảy ra khi SỐ key < số sub-agent đang chạy)
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

// ==================== r71 (BUG2-020a) — 429 KEY ROTATION TRONG CÙNG CALL ====================
// Trước r71: callZenProvider gặp 429 → mark cooldown → return error NGAY —
// không thử key kế. callLLMForAgent thì BỎ 429 khỏi regex retry (comment
// "chuỗi đằng sau xử lý" — nhưng chuỗi = CLI thiếu binary → failover model
// bị skip khi trùng model chính space-bunny-free) → 1 key 429 giết cả call
// dù 2 key kia khỏe (bằng chứng r70: 2 delegation chết + evaluator rơi
// fallback + mission dừng no_progress — chỉ vì key #1 FreeUsageLimitError).
// Giờ: chọn key CỨNG (khỏi 429-cooldown, ưu tiên chưa bị ghim) — KHÔNG
// fail-open trả key đang cooldown. Vòng xoay key bên trong callZenProvider
// dùng hàm này; hết key sạch → trả lỗi tổng hợp trạng thái từng key.

/** r71 (BUG2-020d) — phân loại body 429: FreeUsageLimit (hạn mức free usage,
 * cửa sổ dài — r70 kéo dài ≥8 phút) vs RPM burst (cooldown ngắn). Pure —
 * test trực tiếp không đụng network. */
export function classifyZen429Body(errBody: string): 'free_usage' | 'rpm' {
  return /freeusage|free[_\s-]?usage|usage[_\s-]?limit|daily[_\s-]?(limit|quota)/i.test(errBody)
    ? 'free_usage'
    : 'rpm'
}

/** r71 (BUG2-020a) — lõi PURE của getZenKeyStrict: từ trạng thái cooldown +
 * binding + con trỏ round-robin, chọn index key sạch kế tiếp.
 * Lượt 1: key khỏe + chưa bị ghim. Lượt 2: key khỏe (chia sẻ tạm khi hết
 * key riêng). Trả index=-1 khi TẤT CẢ key đều đang cooldown. */
export function pickHealthyZenKeyIndex(
  cooldowns: number[],
  now: number,
  nextIndex: number,
  boundIndexes: number[],
): { index: number; next: number } {
  const n = cooldowns.length
  if (n === 0) return { index: -1, next: nextIndex }
  const bound = new Set(boundIndexes)
  // Lượt 1 — key khỏe hoàn toàn (không cooldown, không bị ghim)
  for (let i = 0; i < n; i++) {
    const idx = ((nextIndex % n) + i) % n
    if (cooldowns[idx] <= now && !bound.has(idx)) return { index: idx, next: (idx + 1) % n }
  }
  // Lượt 2 — key khỏe nhưng đang bị ghim (chia sẻ key lúc key riêng chết)
  for (let i = 0; i < n; i++) {
    const idx = ((nextIndex % n) + i) % n
    if (cooldowns[idx] <= now) return { index: idx, next: (idx + 1) % n }
  }
  return { index: -1, next: nextIndex }
}

/** r71 (BUG2-020c) — key ghim của sub-agent còn DÙNG ĐƯỢC không? (429-cooldown
 * → KHÔNG — sub-agent phải tạm rời ghim xoay key khỏe). Pure. */
export function boundZenKeyUsable(boundIndex: number | null | undefined, cooldowns: number[], now: number): boolean {
  if (boundIndex == null || boundIndex < 0 || boundIndex >= cooldowns.length) return false
  return cooldowns[boundIndex] <= now
}

function getZenKeyStrict(): { key: string; index: number } | null {
  const picked = pickHealthyZenKeyIndex(zenKey429Until, Date.now(), zenKeyIndex, [...activeZenKeyBindings])
  if (picked.index < 0) return null // TẤT CẢ key đều đang 429-cooldown — KHÔNG fail-open trả key chết
  zenKeyIndex = picked.next
  return { key: ZEN_API_KEYS[picked.index], index: picked.index }
}

/** Cooldown cho 429 thường (RPM burst) vs FreeUsageLimitError (hạn mức free
 * usage — cửa sổ dài; r70 kéo dài ≥8 phút). Override qua env. */
const ZEN_429_COOLDOWN_MS = Math.max(5_000, parseInt(process.env.ZEN_429_COOLDOWN_MS || '60000', 10) || 60_000)
const ZEN_FREE_USAGE_COOLDOWN_MS = Math.max(60_000, parseInt(process.env.ZEN_FREE_USAGE_COOLDOWN_MS || '900000', 10) || 900_000)

/** Cooldown áp dụng theo phân loại body — pure (test trực tiếp). */
export function zen429CooldownFor(errBody: string): number {
  return classifyZen429Body(errBody) === 'free_usage' ? ZEN_FREE_USAGE_COOLDOWN_MS : ZEN_429_COOLDOWN_MS
}

/** Mark a Zen key as rate-limited.
 * r71 (BUG2-020d): cooldown tham số hóa — body 429 chứa FreeUsageLimit →
 * cooldown dài (mặc định 15') vì hạn mức free usage không reset trong 60s;
 * 429 thường (RPM) giữ 60s như cũ. */
function markZenKey429(index: number, cooldownMs: number = ZEN_429_COOLDOWN_MS): void {
  zenKey429Until[index] = Date.now() + cooldownMs
}

/** Chuỗi trạng thái key (log + error khi mọi key 429) — "key #N: còn Xs". */
function zenKeyCooldownSummary(): string {
  const now = Date.now()
  return ZEN_API_KEYS.map((k, i) => {
    const remain = zenKey429Until[i] - now
    return `key#${i + 1}: ${remain > 0 ? `429 còn ${Math.ceil(remain / 1000)}s` : 'khả dụng'} (...${k.slice(-6)})`
  }).join(' · ')
}

// ==================== ZEN FREE-TIER BLOCK CACHE (Task 34 — 2026-09-27) ====================
// THỰC NGHIỆM 2026-09-27 (trả lời câu hỏi user "tại sao TMO không gọi được Zen
// trong khi opencode ở công ty vẫn chạy"): OpenCode Zen ĐỔI POLICY server-side
// ~25-26/09 — các model free (TRỪ space-bunny-free) trả 403 FreeTierError
// "free tier can only be used from within OpenCode" cho:
//   (a) HTTP trực tiếp với oc_sk API key — đã test 11 model free: chỉ space-bunny-free 200
//   (b) CHÍNH opencode CLI v1.18.32 (mới nhất npm) với auth type:api cùng key — vẫn 403
//   (c) Replicate đủ header client thật (User-Agent: opencode/1.18.32 ai-sdk/...;
//       x-opencode-client: cli; x-opencode-session/request/project — bắt từ capture
//       request CLI thật) qua curl + bun fetch — VẪN 403 → check ở TẦNG CREDENTIAL
//       (account OAuth / key có credit), không spoof được bằng header.
// → CẬP NHẬT 2026-10-09 (r72 — user request "nhiều model free thay vì chỉ SBF"):
//   thí nghiệm lại với opencode CLI v1.18.35 cho thấy (b) CHẾ TẮT — CLI với
//   auth type:api (key oc_sk) qua provider NATIVE "opencode" (auth.json) chạy
//   ĐƯỢC model free (ling-3.1-flash-free + mimo-v2.6-flash-free trả lời thật;
//   policy "from within OpenCode" = phải đi qua transport native của client,
//   không phải credential OAuth). Chỉ HTTP trực tiếp + custom provider
//   (@ai-sdk/openai-compatible alias) vẫn bị chặn → cache dưới đây giờ chỉ áp
//   cho 2 transport bị chặn đó; đường CLI native route riêng (llm.ts r72).
// → CẬP NHẬT 2026-10-09 ~09:30Z (r74 — REVIEW PHÁT HIỆN): CỬA SỔ NATIVE ĐÃ
//   ĐÓNG LẠI — Zen chặn toàn bộ model free ngoài SBF trên MỌI transport:
//   probe trực tiếp `opencode run --model opencode/{big-pickle,mimo}` trả
//   403 FreeTierError "free tier can only be used from within OpenCode"
//   (cf-placement remote-ORD) từ CẢ /tmp LẪN app-dir, với CẢ key #1 LẪN key #2
//   (auth.json HOME-override) → CHẮN POLICY TOÀN CỤC, KHÔNG phải quota key,
//   KHÔNG phải "sandbox app-dir quota" như r73 đoán (sai chẩn đoán — đính
//   chính trong Bug_v2.md BUG2-033). SBF vẫn chạy OK trên cả HTTP (xoay key)
//   LẪN native CLI LẪN alias CLI (bằng chứng: utility-core writeback OK ngay
//   trước đó). Hệ quả: 7 model free ngoài SBF trong dropdown cascading về
//   ZEN FAILOVER SBF — agent KHÔNG chết (chuỗi nhiều lớp r73), nhưng model
//   user chọn không trực tiếp phục vụ → /api/agents/models gắn blockedTransports
//   (từ zenModelBlockSummary dưới đây) để UI nói thật. Policy Zen lật ngược
//   nhiều lần (09-27 chặn → r72 mở → r74 chặn) — KHÔNG xoá model khỏi catalog,
//   chỉ hiển thị trạng thái sống thực.
// → Diễn giải cũ (2026-09-27): model free chỉ chạy với credential ĐĂNG NHẬP
//   account hoặc key có credit — ĐÃ LỖI THỜI.
// Cache trạng thái chặn per (transport, model) TTL 15 phút: lần đầu gặp 403 đánh
// dấu → các lần sau skip ngay (không lặp HTTP ~1s + CLI spawn ~5-10s mỗi call),
// caller đi thẳng ZEN FAILOVER. Override: ZEN_FREE_TIER_CACHE_MS (ms; 0 = tắt).
const ZEN_FREE_TIER_CACHE_MS = parseInt(process.env.ZEN_FREE_TIER_CACHE_MS || '900000', 10)
// r74 — value lưu kèm reason (cho zenModelBlockSummary → tooltip UI nói thật)
const zenFreeTierBlockedUntil = new Map<string, { until: number; reason: string }>() // key `${transport}:${model}`

// ==================== r74b — BLOCK-STATE DÙNG CHUNG GIỮA CÁC PROCESS ====================
// VẤN ĐỀ (phát hiện lúc nghiệm thu r74): Next.js dev nạp llm.ts THÀNH NHIỀU
// INSTANCE — goal-loop-worker chạy qua instrumentation (boot-time), API route
// chạy qua registry route (xem goal-loop-worker.ts:1326 đã ghi nhận "2
// instance khác nhau") → markZenFreeTierBlocked trong worker KHÔNG thấy được
// bởi /api/agents/models (route instance có cache riêng trống) → dropdown ⚠
// không bao giờ hiện dù failover thật sự xảy ra.
// GIẢI PHÁP (hardcode tầng mã): state chặn ghi ra FILE dùng chung
// db/zen-block-state.json (mọi process đều chạy từ app-dir):
//   - mark() → ghi memory + merge file (best-effort, prune hết hạn khi ghi)
//   - isZenFreeTierBlocked()/zenModelBlockSummary() → đọc memory GỘP file
//     (file cache theo mtime — re-read chỉ khi file đổi, chi phí ~0 trên
//     đường call LLM đã tốn hàng giây mạng)
//   - Lợi phụ: process mới khởi động (restart PM2) đọc ngay trạng thái chặn
//     từ file → KHÔNG đốt lại HTTP ~1s + CLI spawn ~5s cho mỗi model đã biết
//     chết (trước đây memory trắng = re-probe toàn bộ sau mỗi restart).
//   - Fail-open 2 chiều: lỗi đọc/ghi file → tiến hành như cũ (memory in-process).
type ZenBlockEntry = { until: number; reason: string }
// Đường dẫn mặc định TƯƠNG ĐỐI — resolve 1 lần theo cwd lúc dùng (mọi process
// PM2 chạy từ app-dir; resolve trễ để bắt đúng cwd của process gọi).
const ZEN_BLOCK_STATE_FILE_DEFAULT = 'db/zen-block-state.json'
let zenBlockStateAbsPath: string | null = null
function zenBlockStateFile(): string {
  if (!zenBlockStateAbsPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    zenBlockStateAbsPath = path.resolve(process.env.ZEN_BLOCK_STATE_FILE || ZEN_BLOCK_STATE_FILE_DEFAULT)
  }
  return zenBlockStateAbsPath
}

let zenBlockFileCache: { mtimeMs: number; state: Record<string, ZenBlockEntry> } | null = null

function readZenBlockStateFile(): Record<string, ZenBlockEntry> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    const file = zenBlockStateFile()
    const st = fs.statSync(file)
    if (zenBlockFileCache && zenBlockFileCache.mtimeMs === st.mtimeMs) return zenBlockFileCache.state
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const state = raw && typeof raw === 'object' ? raw as Record<string, ZenBlockEntry> : {}
    zenBlockFileCache = { mtimeMs: st.mtimeMs, state }
    return state
  } catch {
    return zenBlockFileCache?.state || {} // file chưa có/lỗi → dùng cache cũ nếu có (tránh giật); không có → rỗng
  }
}

function writeZenBlockStateFile(mergeKey: string, entry: ZenBlockEntry): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    const now = Date.now()
    const merged: Record<string, ZenBlockEntry> = {}
    // File là nguồn của process khác; memory là nguồn process này — gộp cả hai
    for (const [k, v] of Object.entries(readZenBlockStateFile())) {
      if (v && typeof v.until === 'number' && v.until > now) merged[k] = v
    }
    for (const [k, v] of zenFreeTierBlockedUntil) {
      if (v.until > now) merged[k] = { until: v.until, reason: v.reason }
    }
    merged[mergeKey] = entry
    const file = zenBlockStateFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n')
    zenBlockFileCache = null // invalidate — lần đọc sau lấy file mới (đồng bộ mtime cross-process)
  } catch { /* best-effort — in-memory vẫn hoạt động trong process này */ }
}

function getZenBlockedEntry(transport: 'http' | 'cli', model: string): ZenBlockEntry | null {
  const key = `${transport}:${model}`
  const mem = zenFreeTierBlockedUntil.get(key)
  if (mem && Date.now() < mem.until) return mem
  const fileEntry = readZenBlockStateFile()[key]
  if (fileEntry && typeof fileEntry.until === 'number' && Date.now() < fileEntry.until) {
    // Process này chưa tự gặp lỗi — process khác (worker) đã gặp. Nạp vào memory
    // để các call sau skip thẳng không cần đọc file lại.
    zenFreeTierBlockedUntil.set(key, fileEntry)
    return fileEntry
  }
  return null
}

function isZenFreeTierBlocked(transport: 'http' | 'cli', model: string): boolean {
  if (!(ZEN_FREE_TIER_CACHE_MS > 0)) return false
  return getZenBlockedEntry(transport, model) !== null
}

// r74 — export cho unit-test (cùng pattern parseZenLastResortModels r73):
// test vá cache rồi đối chiếu zenModelBlockSummary() — xem tests/r74.
export function markZenFreeTierBlocked(transport: 'http' | 'cli', model: string, reason: string, ttlMs?: number): void {
  const ttl = ttlMs ?? ZEN_FREE_TIER_CACHE_MS
  if (!(ttl > 0)) return
  const key = `${transport}:${model}`
  const prev = zenFreeTierBlockedUntil.get(key)
  if (prev && Date.now() < prev.until) return // đã chặn rồi — không spam log
  const entry = { until: Date.now() + ttl, reason }
  zenFreeTierBlockedUntil.set(key, entry)
  writeZenBlockStateFile(key, entry) // r74b — chia sẻ cho mọi process (route API đọc được)
  console.warn(`[ZEN] 🚫 Đánh dấu chặn ${transport}:${model} đến ${new Date(Date.now() + ttl).toLocaleTimeString('vi-VN')} — ${reason}`)
}

/**
 * r74 (BUG2-033 — dropdown model "nói thật"): snapshot trạng thái chặn
 * free-tier ĐANG SỐNG của các model zen (mục đích: /api/agents/models gắn
 * blockedTransports cho từng model → UI hiển thị badge ⚠ + fallback rõ ràng).
 * r74b: nguồn = memory process HIỆN TẠI gộp file dùng chung db/zen-block-state.json
 * (worker instrumentation và API route là 2 instance llm.ts khác nhau — xem
 * goal-loop-worker.ts:1326 — nên bắt buộc phải qua file mới thấy nhau).
 * Pure-read — không side-effect ngoài nạp memory từ file. Chỉ trả entry chưa
 * hết hạn; model không có entry = chưa từng gặp lỗi (không kết luận gì).
 * Rationale: policy Zen lật ngược liên tục (09-27 chặn → r72 mở → r74 chặn
 * lại) — thay vì hardcode-danh-sách-chết tĩnh (lỗi thời sau 1 ngày), UI đọc
 * trạng thái SỐNG từ chính cache mà tầng vận hành đang dùng để ra quyết định
 * skip transport → dropdown và failover LUÔN đồng bộ một nguồn sự thật.
 */
export function zenModelBlockSummary(): Array<{ model: string; transport: 'http' | 'cli'; blockedUntil: number; reason: string }> {
  const now = Date.now()
  // Gộp nguồn: memory (process này) + file (process khác — vd worker durable job)
  const merged = new Map<string, ZenBlockEntry>()
  for (const [k, v] of Object.entries(readZenBlockStateFile())) {
    if (v && typeof v.until === 'number' && v.until > now) merged.set(k, v)
  }
  for (const [k, v] of zenFreeTierBlockedUntil) {
    if (v.until > now) merged.set(k, v)
  }
  const out: Array<{ model: string; transport: 'http' | 'cli'; blockedUntil: number; reason: string }> = []
  for (const [key, entry] of merged) {
    const sep = key.indexOf(':')
    if (sep <= 0) continue
    out.push({
      transport: key.slice(0, sep) as 'http' | 'cli',
      model: key.slice(sep + 1),
      blockedUntil: entry.until,
      reason: entry.reason,
    })
  }
  return out
}

// ==================== P6-M3 — SOFTMAX(τ) STOCHASTIC MODEL-SELECTION ====================
// (BLUEPRINT-STATS-LEARNING-P0-P6 §P6-M3, mục #15 — DL.pdf §Stochastic Policy)
//
// Chống 429-cascade: hôm nay chuỗi model là strictly-one-primary (model từ
// AgentProfile.model) — khi model chính 429, TOÀN hệ thống dồn theo chuỗi
// failover đồng loạt. Softmax phân tán điểm khởi đầu:
//   score(a) = Q(s,a) (§P6-M2 — chưa có → uniform prior theo caps)
//   π(a) = softmax(score/τ)  — τ env RUNTIME_MODEL_TAU (mặc định 0.5)
//   health: model bị chặn (zenModelBlockSummary — free-tier 403) → loại khỏi
//   ứng viên (weight 0). Key 429-cooldown KHÔNG lọc ở đây: key Zen dùng
//   CHUNG cho mọi model (không phân biệt được ứng viên ở tầng này —
//   cooldown áp dụng đều, tầng xoay key bên dưới tự xử lý).
//   Seed tất định hash(sessionId, cycle) — chạy lại được.
//
// Cờ RUNTIME_MODEL_POLICY=softmax (MẶC ĐỊNH OFF — điểm dừng quyết định
// #5 của user: KHÔNG tự ý bật trên đường chạy nóng). Agent CÓ override
// tườ minh (AgentModelOverride — dropdown user chọn) → tôn trọng lựa chọn,
// không softmax. Failover chuỗi cũ GIỮ NGUYÊN TOÀN BỘ (softmax chỉ đổi điểm
// khởi đầu zenModel — spec: "Failover chuỗi cũ giữ nguyên toàn bộ").
//
// NEURAL-ARCH (2026-10-11): policy + τ đọc RUNTIME MỖI LẦN GỌI qua
// tuning-store (runtime_model_policy / runtime_model_tau — chuỗi hiệu lực
// STORE > ENV > DEFAULT) — tinh chỉnh được trên tab Kiến trúc Neural mà
// không restart pm2. parseRuntimeModelTau vẫn ở import cho consumer khác
// tham chiếu chuẩn parse (floor 0.05).

/** Cache AgentModelOverride (bảng nhỏ, 60s — đường call nóng không đập DB mỗi lần). */
let agentModelOverrideCache: { at: number; names: Set<string> } | null = null

/**
 * Agent có override model TƯỜNG MINH từ user không (AgentModelOverride —
 * dropdown)? DB lỗi → true (bảo thủ: giữ model cấu hình — đúng hành vi cũ,
 * không đổi model khi không chắc). Tên agent con ("X (final-report)")
 * được chuẩn hoá về tên gốc trước khi tra.
 */
async function hasExplicitModelOverride(agentName?: string): Promise<boolean> {
  if (!agentName) return false
  const base = agentName.split(' (')[0]
  try {
    if (!agentModelOverrideCache || Date.now() - agentModelOverrideCache.at > 60_000) {
      const { db } = await import('@/lib/db')
      const rows = await db.agentModelOverride.findMany({ select: { agentName: true } })
      agentModelOverrideCache = { at: Date.now(), names: new Set(rows.map(r => r.agentName)) }
    }
    return agentModelOverrideCache.names.has(base)
  } catch {
    return true // DB lỗi → coi như có override (bảo thủ giữ model cũ)
  }
}

/**
 * Áp dụng softmax policy cho zenModel (P6-M3) — trả về model được chọn làm
 * điểm khởi đầu chuỗi Zen. Mọi nhánh fail-open về model cấu hình (policy
 * là lớp học — không được làm chết call). Log mỗi lần chọn theo
 * đúng format spec: `softmax-pick model=X q=0.42 p=0.31 reason=…`.
 */
async function maybeApplySoftmaxModelPolicy(configuredZenModel: string, options?: LLMCallOptions): Promise<string> {
  // NEURAL-ARCH: resolve runtime (STORE > ENV > 'off') — mặc định vẫn OFF
  // đúng điểm dừng #5; env fallback giữ nguyên ngữ nghĩa bản FB-P6 (env
  // 'softmax' → bật, giá trị khác → off).
  if (getTuningEnum('runtime_model_policy') !== 'softmax') return configuredZenModel
  // Override tườ minh của user → tôn trọng (spec: "Chọn primary khi agent
  // KHÔNG có override tườ minh")
  if (await hasExplicitModelOverride(options?.agentName)) {
    console.log(`[LLM] softmax-pick model=${configuredZenModel} p=1.00 reason=agent-có-override-tường-minh — giữ nguyên`)
    return configuredZenModel
  }
  try {
    const [{ PROVIDER_MODELS }, { getQAdvice, softmaxPolicy, deterministicSeed, pickIndexBySeed, agentRuntimeStateKey }] = await Promise.all([
      import('@/lib/agent-constants'),
      import('@/lib/learning/q-table'),
    ])
    // Ứng viên: model zen có caps phù hợp vai agent (coding ∧ reasoning —
    // mọi model catalog đỡu battery r73; KHÔNG lọc agentic: SBF lõi chính chỉ
    // đạt agentic:false vì goal-loop chạy tool qua TEXT PROTOCOL không cần
    // native FC — lọc agentic sẽ loại sai lòi chính) ∧ KHÔNG bị chặn
    // health (zenModelBlockSummary — spec: "KHÔNG nằm trong blocked").
    const blockedModels = new Set(zenModelBlockSummary().map(b => b.model))
    const candidates = (PROVIDER_MODELS.zen ?? [])
      // FB-P6-R1-B-05: whitelist === true — model KHÔNG khai báo caps (undefined
      // / gõ nhầm key) không được mặc nhiên thành ứng viên (bản trước !== false
      // cho undefined lọt qua — lỗ hổng tiềm ẩn khi catalog thêm model thiếu caps)
      .filter(m => m.caps?.coding === true && m.caps?.reasoning === true && !blockedModels.has(m.id))
      .map(m => m.id)
    if (candidates.length === 0) {
      console.log(`[LLM] softmax-pick model=${configuredZenModel} p=1.00 reason=0-ứng-viên-sống — giữ nguyên (failover chuỗi cũ xử lý)`)
      return configuredZenModel
    }
    if (candidates.length === 1) {
      console.log(`[LLM] softmax-pick model=${candidates[0]} p=1.00 reason=1-ứng-viên-sống`)
      return candidates[0]
    }
    // Q(s,a) — chưa có dữ liệu → toàn 0 → uniform prior theo caps (spec)
    const stateKey = agentRuntimeStateKey()
    const advice = await getQAdvice(stateKey, candidates)
    const qByAction = new Map(advice.map(a => [a.action, a.q]))
    const scores = candidates.map(c => qByAction.get(c) ?? 0)
    const probs = softmaxPolicy(scores, getTuningNumber('runtime_model_tau'))
    // Seed tất định hash(sessionId, cycle) — chạy lại được (spec §P6-M3).
    // FB-P6-R1-B-06 (ghi nhận, chấp nhận): call thiếu cả sessionId lẫn agentName
    // → seed 'anon' cố định (mọi call như vậy cùng chọn 1 model) — mọi call-site
    // lớn hiện truyền agentName nên nhánh này hiếm; giữ tất định theo spec
    // (thêm nhiễu thời gian sẽ phá "chạy lại được" — không đổi).
    const seed = deterministicSeed(
      String(options?.sessionId ?? options?.agentName ?? 'anon'),
      String(options?.qPolicyCycle ?? 0),
    )
    const idx = pickIndexBySeed(probs, seed)
    if (idx < 0) return configuredZenModel
    const picked = candidates[idx]
    console.log(`[LLM] softmax-pick model=${picked} q=${scores[idx].toFixed(2)} p=${probs[idx].toFixed(2)} reason=τ=${getTuningNumber('runtime_model_tau')} ${candidates.length}-ứng-viên seed=${seed}${picked !== configuredZenModel ? ` (thay ${configuredZenModel})` : ''}`)
    return picked
  } catch (err) {
    console.warn('[LLM] softmax policy failed (fail-open → model cấu hình):', err instanceof Error ? err.message : String(err))
    return configuredZenModel
  }
}

// ==================== ZEN REASONING EFFORT — CHẾ ĐỘ CAO NHẤT (Task 33) ====================
// USER DIRECTIVE 2026-09-27: "2 model của zen là Nemotron 3 Ultra và Muse-Spark
// 1.3 Contributor — chế độ cao nhất cho tôi (tôi chỉ biết model có Max nhưng
// nếu có cao hơn thì thiết lập)".
// Kiểm chứng metadata models.dev + test thực tế API (space-bunny reasoning_effort
// max hoạt động thật — 36 reasoning tokens cho câu hỏi nhỏ; giá trị không hợp lệ
// bị BỎ QUA ÂM THẦM — nên map sai = mất effort, không báo lỗi):
//   - muse-spark-1.3-contributor-free : effort minimal|low|medium|high|xhigh
//     → CAO NHẤT = xhigh (model KHÔNG có mức max)
//   - muse-spark-1.2-contributor-free : effort như trên → xhigh
//   - space-bunny-free               : effort low|medium|high|xhigh|max
//     → CAO NHẤT = max (mức cao nhất toàn hệ Zen)
//   - nemotron-3-ultra-free / nemotron-3.5-lightning-free / mimo: KHÔNG có
//     effort knob (reasoning always-on, interleaved reasoning_content) — không
//     gửi reasoning_effort (gửi cũng bị bỏ qua âm thầm).
// Override toàn cục qua env ZEN_REASONING_EFFORT (vd "high" để tiết kiệm token
// khi cần; đặt "none" để tắt hẳn) — mặc định dùng map chế độ cao nhất theo model.
export function zenReasoningEffortForModel(model: string): string | undefined {
  const forced = process.env.ZEN_REASONING_EFFORT?.trim().toLowerCase()
  if (forced === 'none') return undefined
  if (forced) return forced
  if (model.startsWith('muse-spark-')) return 'xhigh' // cao nhất của muse-spark
  if (model === 'space-bunny-free') return 'max' // cao nhất của space-bunny
  return undefined // nemotron/lightning/mimo: không có effort knob
}

/** Danh sách model zen hợp lệ (dùng normalize agent DB cũ NIM → zen).
 * r72 (2026-10-09): bổ sung các model free mới từ GET /zen/v1/models — dùng
 * được qua đường CLI native (llm.ts tự route; verified ling + mimo trả lời thật). */
const ZEN_KNOWN_MODELS = new Set([
  'space-bunny-free',
  'ling-3.1-flash-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free', // đã rời catalog Zen (2026-10-09) — giữ để normalize row cũ
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free',
  'jev-1.13-free',
  'step-5-preview-free',
  'longcat-2.5-preview-free',
  'big-pickle',
])

function isZenModelId(model: string): boolean {
  return ZEN_KNOWN_MODELS.has(model.trim())
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
  // USER DIRECTIVE 2026-10-29b — key GHIM riêng cho sub-agent: nếu async
  // context hiện tại đang chạy trong runWithZenKeyBinding(i) → dùng đúng key
  // #i (concurrent sub-agent không bao giờ dùng chung key). Caller thường
  // (parent/utility) → getZenKey() round-robin tự NÉ key đang bị ghim.
  // r71 (BUG2-020c): key ghim đang 429-cooldown → getBoundZenKey trả null →
  // tạm rời ghim, xoay key khỏe (log rõ). KHÔNG bao giờ dập lại key chết.
  let keyInfo = getBoundZenKey() ?? getZenKey()
  if (!keyInfo) {
    console.warn('[ZEN] No API keys configured (set ZEN_API_KEY_1 / ZEN_API_KEY_2 / ZEN_API_KEY_3 in .env)')
    return null
  }
  if (hasAbandonedZenBinding()) {
    console.warn(`[ZEN] ${taskLabel} key ghim đang 429-cooldown — TẠM RỜI GHIM, xoay sang key khỏe #${keyInfo.index + 1} (r71 BUG2-020c: key riêng 429 thì đổi key khác — chia sẻ key còn hơn chết chờ)`)
  }

  // TASK 34 — free-tier block cache: model đã bị chặn ở HTTP (gặp FreeTierError
  // trong 15 phút) → skip fetch thẳng để caller sang CLI/failover NGAY
  if (isZenFreeTierBlocked('http', model)) {
    return { content: '', provider: 'zen', model, error: 'Zen HTTP free-tier blocked (cached — model bị Zen chặn với API key, policy ~2026-09-25)' }
  }

  // ROUND-3 FIX (2026-09-29 — quan sát vận hành vòng 3): timeout co giãn theo
  // kích thước INPUT. Bằng chứng dev.log ~07:2x: evaluator chu kỳ 17 MEGATRON
  // (context ~60K tokens, effort=max + unlimited output theo user directive
  // 2026-09-28) bị abort đúng 300s (ZEN_TIMEOUT_MS) → SHR verify từ chối chu
  // kỳ → auto-escalate → delegation ALISTA vô ích 33K tokens/333s (nguyên nhân
  // gốc là infra-timeout, không phải agent bế tắc). Prefill + queue + reasoning
  // max của context lớn cần nhiều hơn 5 phút tĩnh: timeout hiệu dụng =
  // max(base, estInputTokens × ZEN_TIMEOUT_MS_PER_INPUT_TOKEN, default 8ms).
  // 60K tokens → 480s; call nhỏ giữ sàn 300s. Tắt scaling: set =0.
  const zenBaseTimeoutMs = parseInt(process.env.ZEN_TIMEOUT_MS || '300000', 10)
  const zenTimeoutPerInputTokenMs = Math.max(0, parseInt(process.env.ZEN_TIMEOUT_MS_PER_INPUT_TOKEN || '8', 10) || 8)
  // ROUND-54 FIX D: dùng tỷ lệ chars/token ĐÃ HIỆU CHUẨN từ usage thật của các
  // call trước (EMA) thay vì hằng số 4 — transcript JSON-dense thực tế ~2.1-2.8
  // chars/token (bằng chứng r54: est 147k vs thật 312k = thiếu 53%). Mặc định 4
  // giữ hành vi cũ cho call đầu tiên của process.
  const zenInputChars = prompt.length + (systemPrompt?.length ?? 0)
  const zenCharsPerToken = zenCharsPerTokenEma ?? 4
  const estInputTokens = Math.ceil(zenInputChars / zenCharsPerToken)
  const timeoutMs = Math.max(
    zenBaseTimeoutMs,
    zenTimeoutPerInputTokenMs > 0 ? estInputTokens * zenTimeoutPerInputTokenMs : 0,
  )
  if (timeoutMs > zenBaseTimeoutMs) {
    console.log(`[ZEN] ${taskLabel} timeout co giãn theo input: ${zenBaseTimeoutMs}ms → ${timeoutMs}ms (est ~${estInputTokens} input tokens × ${zenTimeoutPerInputTokenMs}ms${zenCharsPerTokenEma != null ? `, calib ${zenCharsPerToken.toFixed(2)} chars/token (EMA từ usage thật — FIX D r54)` : ''})`)
  }
  // Task 39 — UNLIMITED TOKEN MODE: maxTokens <= 0 (vd -1 từ AgentProfile
  // "tùy ý") → KHÔNG gửi max_tokens → provider dùng giới hạn output tối đa
  // của model (space-bunny-free: 512k out). Verified 2026-09-28: Zen API chấp
  // nhận request không có max_tokens kèm reasoning_effort=max.
  const maxTokens = options?.maxTokens ?? 16384
  const temperature = options?.temperature ?? 0.4

  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: sanitizeLoneSurrogates(systemPrompt) }] : []),
    { role: 'user', content: sanitizeLoneSurrogates(prompt) },
  ]

  // TASK 33 — chế độ reasoning CAO NHẤT theo model (muse-spark=xhigh,
  // space-bunny=max; nemotron không có knob). Xem zenReasoningEffortForModel.
  // TASK 55: options.reasoningEffort override ('none' = tắt hẳn).
  const effortOverride = options?.reasoningEffort?.trim().toLowerCase()
  const effort = effortOverride === 'none'
    ? undefined
    : (effortOverride || zenReasoningEffortForModel(model))

  // ===== ANTI-STARVATION (USER DIRECTIVE 2026-09-28: space-bunny LUÔN LUÔN
  // effort MAX + token KHÔNG GIỚI HẠN — "agents tự dùng bao nhiêu cũng được",
  // "chỉnh lên thật lớn") =====
  // reasoning_tokens TRỪ vào max_tokens (cùng pool completion tokens). Bằng
  // chứng dev.log 28/09: agent:space-bunny-free EMPTY RESPONSE —
  // max_tokens=1100, reasoning_tokens=1100, 0 chars, finish=length (reasoning
  // nuốt HẾT budget — 200 OK ÂM THẦM). Task 55 chỉ chữa đường utility (ép
  // effort low); đường agent/gọi trực tiếp với maxTokens nhỏ (delegation-
  // evaluator 700, subagent-delegate 900, tl-bridge 1024, king/engine 800,
  // tournament 200-800, intent-parser 10...) vẫn starvation. Giờ: effort ở
  // mức CAO NHẤT (max/xhigh) → KHÔNG gửi max_tokens — provider dùng output
  // tối đa của model (space-bunny 512k), reasoning mở rộng tự do, content
  // luôn còn budget. Caller THẬT SỰ muốn ép budget nhỏ phải truyền
  // reasoningEffort thấp ('low'/'none') — khi đó max_tokens được tôn trọng.
  const effectiveMaxTokens = (effort === 'max' || effort === 'xhigh') && maxTokens > 0 ? -1 : maxTokens
  if (effectiveMaxTokens !== maxTokens) {
    console.log(`[ZEN] ${taskLabel} effort=${effort} → bỏ max_tokens=${maxTokens} (unlimited output — chống reasoning starvation, user directive 2026-09-28: luôn max effort + token không giới hạn)`)
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    ...(effectiveMaxTokens > 0 ? { max_tokens: effectiveMaxTokens } : {}),
    temperature,
  }
  if (effort) body.reasoning_effort = effort
  // TASK D (token efficiency 2026-10-30) — skipNativeTools: caller xin KHÔNG
  // đính kèm body.tools (model hiện tại bỏ qua native FC — schema JSON ~7k
  // tokens/vòng là dead weight). Caller khác không đặt cờ → giữ nguyên hành vi.
  if (options?.tools && options.tools.length > 0 && options.skipNativeTools !== true) {
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
    // ━━ r71 (BUG2-020a) — VÒNG XOAY KEY KHI 429 (trong CÙNG call) ━━
    // Bằng chứng r70: key #1 429 FreeUsageLimitError → return error ngay →
    // CLI thiếu binary → failover model trùng model chính bị skip → chuỗi
    // chết sau 1 attempt dù key #2/#3 khỏe. Giờ: 429 → mark cooldown (dài
    // nếu FreeUsageLimit) → chọn key KẾ TIẾP sạch (getZenKeyStrict — không
    // fail-open trả key cooldown) → thử tiếp, tối đa đủ số key. Chỉ trả lỗi
    // khi TẤT CẢ key đều 429 — kèm trạng thái từng key cho operator.
    let response: Response | null = null
    let allKeys429 = false
    for (let keyAttempt = 0; keyAttempt < ZEN_API_KEYS.length; keyAttempt++) {
      response = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keyInfo.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (response.status !== 429) break // key này trả lời thật — thoát vòng xoay
      // ── 429: đánh dấu cooldown (phân loại body) + xoay key kế ngay trong call ──
      let errBody = ''
      try { errBody = await response.text() } catch { /* ignore */ }
      const kind = classifyZen429Body(errBody)
      const cooldownMs = zen429CooldownFor(errBody)
      markZenKey429(keyInfo.index, cooldownMs)
      console.warn(`[ZEN] ${taskLabel} 429 rate-limited (key #${keyInfo.index + 1}) — ${kind === 'free_usage' ? 'FreeUsageLimit (hạn mức free usage — cooldown dài' : 'RPM burst (cooldown ngắn'} ${Math.round(cooldownMs / 1000)}s): ${errBody.slice(0, 120)}`)
      const next = getZenKeyStrict()
      if (!next) {
        allKeys429 = true
        break
      }
      keyInfo = next
      console.log(`[ZEN] ${taskLabel} XOAY KEY → #${keyInfo.index + 1} (còn key khỏe — thử ngay trong cùng call, lần ${keyAttempt + 1})`)
    }
    if (allKeys429) {
      console.warn(`[ZEN] ${taskLabel} TẤT CẢ ${ZEN_API_KEYS.length} key đều 429 — ${zenKeyCooldownSummary()}`)
      return { content: '', provider: 'zen', model, error: `Zen 429: TẤT CẢ ${ZEN_API_KEYS.length} key đều rate-limited — ${zenKeyCooldownSummary()}` }
    }
    if (!response) {
      return { content: '', provider: 'zen', model, error: 'Zen call failed: vòng xoay key không trả response (unreachable)' }
    }

    if (!response.ok) {
      let errBody = ''
      try { errBody = await response.text() } catch { /* ignore */ }
      // TASK 34 — các lỗi POLICY/model-level (không phải lỗi tạm thời) → mark
      // cache bỏ qua các lần sau: FreeTierError (model free chặn API key),
      // RegionError (geo-block), 402 (hết credit cho model trả phí)
      if (response.status === 403 && (errBody.includes('FreeTierError') || errBody.toLowerCase().includes('free tier'))) {
        markZenFreeTierBlocked('http', model, 'HTTP 403 FreeTierError — model free bị Zen chặn với API key ở transport HTTP (chỉ space-bunny-free còn mở API HTTP) — model này sẽ chuyển tiếp về ZEN FAILOVER (r74: native CLI cũng đã bị chặn lại — xem BUG2-033)', 60_000)
      } else if (response.status === 403 && (errBody.includes('RegionError') || /not available in your region/i.test(errBody))) {
        markZenFreeTierBlocked('http', model, 'HTTP 403 RegionError — model geo-block tại vùng máy chủ này')
      } else if (response.status === 402) {
        markZenFreeTierBlocked('http', model, 'HTTP 402 — tài khoản không đủ credit cho model trả phí này (nạp credit để dùng)')
      }
      console.warn(`[ZEN] ${taskLabel} HTTP ${response.status}: ${errBody.slice(0, 200)}`)
      return { content: '', provider: 'zen', model, error: `Zen HTTP ${response.status}: ${errBody.slice(0, 150)}` }
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: LLMToolCall[] }
        finish_reason?: string | null
      }>
      model?: string
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    }

    const choice = data.choices?.[0]
    // ROUND-50 FIX (P3-ζ): strip marker corruption `]<]xxx[>[` của provider tại
    // nguồn — mọi consumer phía sau nhận content sạch (idempotent với tầng
    // parse tool-calls cũ — strip 2 lần vô hại).
    const content = stripProviderGarbleMarkers(choice?.message?.content ?? '')
    const nativeToolCalls = choice?.message?.tool_calls
    const finishReason = choice?.finish_reason ?? null
    const actualModel = data.model || model
    const totalTokens = data.usage?.total_tokens ?? ((data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0))

    if (!content && !(nativeToolCalls && nativeToolCalls.length > 0)) {
      // TASK 55: đường fail ÂM THẦM duy nhất của callZenProvider — 200 OK nhưng
      // content rỗng. Từng KHÔNG log gì → khối ngầm.utility đợi heuristic fallback
      // mà không ai biết lý do (compression LLM fail 15/15 lần không dấu vết).
      // finish_reason=length + max_tokens nhỏ + reasoning_effort cao = reasoning
      // nuốt hết budget → xem reasoningEffort trong LLMCallOptions.
      console.warn(`[ZEN] ${taskLabel} EMPTY RESPONSE — finish_reason=${finishReason ?? 'null'}, max_tokens=${(body.max_tokens as number | undefined) ?? 'unlimited'}, reasoning_effort=${(body.reasoning_effort as string | undefined) ?? 'none'}, usage=${JSON.stringify((data.usage as Record<string, unknown> | undefined)?.completion_tokens_details ?? {})} — model trả 200 nhưng 0 content (reasoning starvation?)`)
      return { content: '', provider: 'zen', model: actualModel, error: `Zen empty response, finish_reason=${finishReason ?? 'null'} (${taskLabel})` }
    }

    // Token tracking — per-provider + per-agent (mirror NIM pattern)
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? undefined
    // ROUND-54 FIX D — ghi nhận tỷ lệ chars/prompt_token thật để hiệu chuẩn
    // ước lượng timeout của call kế (xem recordZenCharsPerToken — bằng chứng
    // r54: hằng số 4 thấp hơn thực tế 40-53% với transcript JSON-dense)
    recordZenCharsPerToken(zenInputChars, data.usage?.prompt_tokens)
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

    // TASK D (telemetry 2026-10-30) — tách prompt/completion ngay trong log
    // [ZEN] để đo bloat theo call (Task B: system+schemas ~45% vs transcript
    // — không có split thì phải đoán từ TokenTracker DB sau khi flush).
    console.log(`[ZEN] ${taskLabel} [key #${keyInfo.index + 1}] OK — ${content.length} chars, model ${actualModel}${totalTokens ? `, ${totalTokens} tokens (prompt: ${data.usage?.prompt_tokens ?? 0} / completion: ${data.usage?.completion_tokens ?? 0})` : ''}${reasoningTokens !== undefined ? ` (reasoning: ${reasoningTokens} tokens)` : ''}`)
    return {
      content,
      provider: 'zen',
      model: actualModel,
      tokensUsed: totalTokens || undefined,
      reasoningTokens,
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
// OpenCode Zen free models (suffix -free) bị chặn "from within OpenCode" với
// oc_sk API key. Ngày 24-25/09 CLI còn chạy được free models; TỪ ~25-26/09/2026
// Zen chặn CẢ CLI với auth type:api (verified 2026-09-27 — opencode v1.18.32
// mới nhất nhận FreeTierError 403). r72 (2026-10-09): vault thực nghiệm đảo
// ngược — CLI v1.18.35 + auth type:api qua provider NATIVE chạy được model
// free; chỉ custom provider (alias HTTP) vẫn bị chặn. callOpenCodeCLIProvider
// giờ route SBF qua alias xoay key, model free khác qua native.
//
// Output format: `--format json` stream events (step_start, text, step_finish).
// Parse text events → accumulate content + reasoning + tokens.
// Fallback: CLI fail → caller (callLLMForAgent) chuyển ZEN FAILOVER (Task 33+).
// TASK 34 (2026-09-27): free models qua CLI với auth type:api cũng bị Zen chặn
// (policy mới ~25-26/09) — r72 (2026-10-09): đã LỖI THỜI cho provider native
// (auth.json type:api chạy được — xem callOpenCodeCLIProvider); cache chỉ còn
// áp cho custom alias transport.

// ==================== OPENCODE CLI BINARY RESOLVER (Task 34 — đa nền tảng) ====================
// Trước đây: const OPENCODE_CLI_BIN = env || '/home/z/.opencode/bin/opencode'
// (mặc định là path sandbox Linux) — máy Windows local của user set env theo
// .env mẫu từ sandbox → binary "không tồn tại" → CLI fallback chết cứng dù
// opencode ĐÃ cài (log user 2026-09-27: "Binary không tồn tại tại /home/z/...").
// Giờ: resolver thử theo thứ tự env → vị trí chuẩn theo OS (homedir) → npm
// global (Windows) → tìm trong PATH (which/where). Kết quả cache 60s (nhận
// opencode được cài sau khi app đã chạy mà không cần restart).
const OPENCODE_CLI_ENABLED = (process.env.OPENCODE_CLI_ENABLED || 'true').trim().toLowerCase() !== 'false'
const OPENCODE_CLI_TIMEOUT_MS = parseInt(process.env.OPENCODE_CLI_TIMEOUT_MS || '240000', 10)
let ocCliBinCache: { bin: string | null; at: number } | null = null
let lastCliMissingWarnAt = 0

/** Tìm binary opencode CLI đa nền tảng (Linux/macOS/Windows). null = không thấy. */
function resolveOpenCodeCliBin(): string | null {
  const now = Date.now()
  if (ocCliBinCache && now - ocCliBinCache.at < 60_000) return ocCliBinCache.bin
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path') as typeof import('path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os')
  const isWin = process.platform === 'win32'
  const tried: string[] = []
  const candidates: string[] = []
  const envBin = process.env.OPENCODE_CLI_BIN?.trim()
  if (envBin) candidates.push(envBin)
  const exe = isWin ? 'opencode.exe' : 'opencode'
  candidates.push(path.join(os.homedir(), '.opencode', 'bin', exe))
  if (isWin && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'opencode.cmd'))
  if (isWin && process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'npm', 'opencode.cmd'))
  for (const c of candidates) {
    tried.push(c)
    try {
      if (fs.existsSync(c)) {
        ocCliBinCache = { bin: c, at: now }
        return c
      }
    } catch { /* ignore per-candidate error */ }
  }
  // PATH lookup — existsSync không thấy được binary trong PATH → which/where
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require('child_process') as typeof import('child_process')
    const out = execSync(isWin ? 'where opencode' : 'which opencode', {
      timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }) as string
    const first = out.split('\n').map(l => l.trim()).filter(Boolean)[0]
    if (first && fs.existsSync(first)) {
      ocCliBinCache = { bin: first, at: now }
      return first
    }
  } catch { /* không có trong PATH */ }
  ocCliBinCache = { bin: null, at: now }
  // Log gate 5 phút — tránh spam mỗi LLM call khi CLI chưa cài (trước đây in
  // MỖI call, log user lo lắng không cần thiết)
  if (now - lastCliMissingWarnAt > 300_000) {
    lastCliMissingWarnAt = now
    console.warn(`[OC-CLI] Không tìm thấy opencode CLI (đã thử: ${tried.join(' ; ')} ; PATH). Cài: npm i -g opencode-ai (Windows: irm https://opencode.ai/install.ps1 | iex — Linux/mac: curl -fsSL https://opencode.ai/install | bash), hoặc set OPENCODE_CLI_BIN trỏ đúng binary. LƯU Ý: thiếu CLI KHÔNG làm hỏng agent stack — mọi call vẫn chạy qua Zen HTTP + ZEN FAILOVER (space-bunny-free). CLI cần khi muốn dùng model free bị chặn HTTP (r72: native provider + auth.json key oc_sk — app tự nạp key, không cần oauth account).`)
  }
  return null
}

/** Check if OpenCode CLI binary exists + enabled. */
function isOpenCodeCLIAvailable(): boolean {
  if (!OPENCODE_CLI_ENABLED) return false
  return resolveOpenCodeCliBin() !== null
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
  // Task 24 (2026-10-21) — file-op bridges (native write/edit/bash bị deny qua
  // opencode.json permission; agent viết/sửa file qua 2 bridge này → server
  // INFRA GUARD kiểm soát protected paths + audit ToolMetric)
  'tmo_file_write': 'file_write',
  'tmo_file_edit': 'file_edit',
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

// ==================== NATIVE ZEN AUTH SELF-HEAL (user request 2026-10-09) ====================
// Provider native "opencode" của CLI đọc credential từ auth store toàn cục
// ~/.local/share/opencode/auth.json. Sandbox reset / máy mới → file mất →
// native path chết âm thầm. Self-heal: thiếu → ghi từ ZEN_API_KEY_1 (format
// verified 2026-10-09 với opencode v1.18.35 — `opencode auth list` nhận diện
// "OpenCode Zen api"). KHÔNG BAO GIỜ đè file có sẵn (tôn trọng credential
// user tự cấu hình qua `opencode auth login`).
let ocAuthEnsured = false
function ensureOpenCodeAuth(): void {
  if (ocAuthEnsured) return
  ocAuthEnsured = true // chạy 1 lần/process — idempotent tại FS level
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os')
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')
    if (fs.existsSync(authPath)) return // đã có credential (user/phiên trước) — không đè
    const key = ZEN_API_KEYS[0]
    if (!key) return // không có key cấu hình → bỏ qua (HTTP path vẫn chạy)
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    fs.writeFileSync(authPath, JSON.stringify({ opencode: { type: 'api', key } }, null, 2) + '\n', { mode: 0o600 })
    console.log('[OC-CLI] auth.json tự tạo cho native Zen provider (ZEN_API_KEY_1 — user request 2026-10-09)')
  } catch (err) {
    ocAuthEnsured = false // lỗi → cho phép retry lần call sau
    console.warn('[OC-CLI] ensureOpenCodeAuth lỗi (không chặn):', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Call OpenCode Zen model via CLI subprocess (prompt truyền qua STDIN — Task 34).
 * Spawns `opencode run --model <prefix>/<model> --format json` + stdin prompt.
 * Returns LLMResult with content + tokens. On failure → null (caller falls back
 * to ZEN FAILOVER).
 * USER REQUEST 2026-10-09 ("nhiều model free thay vì chỉ SBF") — 2 transport:
 *   - space-bunny-free → alias opencode-k1/k2/k3 (custom HTTP, xoay key pool —
 *     SBF là model DUY NHẤT Zen mở cho HTTP API key nên alias đa key giữ nguyên)
 *   - model free KHÁC → native provider `opencode/<model>` (auth.json key#1).
 *     Verified 2026-10-09 (matrix test opencode CLI v1.18.35): policy Zen chặn
 *     HTTP + custom provider (@ai-sdk/openai-compatible) với 403 "free tier can
 *     only be used from within OpenCode" nhưng CHO PHÉP native provider với
 *     chính key oc_sk. TRẢ LỜI THẬT: ling-3.1-flash-free, mimo-v2.6-flash-free,
 *     step-5-preview-free, longcat-2.5-preview-free, big-pickle. CHẾT (loại khỏi
 *     danh sách agent-constants): nemotron-3.5-lightning-free (treo 5/5),
 *     jev-1.13-free (UnknownError), muse-spark-1.3 (geo-block). Ghi chú cũ "cần
 *     opencode auth login account (oauth)" ĐÃ LỖI THỜI — `opencode auth login
 *     -p opencode` chỉ là dán API key.
 */
async function callOpenCodeCLIProvider(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  options: LLMCallOptions | undefined,
  taskLabel: string,
): Promise<LLMResult | null> {
  if (!OPENCODE_CLI_ENABLED) return null
  // TASK 34 — free-tier block cache: model đã bị Zen chặn ở transport CLI
  // (verified 2026-09-27: chính opencode CLI với auth type:api nhận
  // FreeTierError 403) → skip thẳng, không tốn 5-10s spawn mỗi call
  if (isZenFreeTierBlocked('cli', model)) {
    return null
  }
  const cliBin = resolveOpenCodeCliBin()
  if (!cliBin) {
    return null // đã warn trong resolver (gate 5 phút — không spam mỗi call)
  }

  const { spawn } = await import('child_process')
  // Top-level import (sync) để dùng trong child.on('close') callback — không dùng await trong callback.
  const { extractToolCallsWithDiagnostics } = await import('@/lib/tool-calls')
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt
  // USER REQUEST 2026-10-09 — CHỌN TRANSPORT THEO MODEL (xem docblock trên):
  //   - space-bunny-free: alias opencode-k1/k2/k3 (custom HTTP xoay key pool —
  //     MULTI-KEY ROTATION fix 2026-09-25 giữ nguyên: opencode.json định nghĩa
  //     alias trùng baseURL zen, khác API key; key ghim sub-agent (2026-10-29b)
  //     → CLI dùng đúng alias key đó, đồng bộ HTTP path; key 429-cooldown tự
  //     bị bỏ qua lần spawn sau).
  //   - model free KHÁC (bị Zen chặn HTTP 403 "free tier...from within
  //     OpenCode"): native provider `opencode/<model>` + auth.json (self-heal
  //     ensureOpenCodeAuth). Đa key KHÔNG áp dụng được cho native (auth store
  //     1 credential/provider) — chấp nhận: đây là model phụ trợ, SBF vẫn là
  //     lõi xoay key chính.
  const isSbf = model === 'space-bunny-free'
  let cliProviderPrefix = 'opencode' // native (auth.json) — KHÔNG còn shadow custom ở repo opencode.json
  if (isSbf) {
    try {
      const keyInfo = getBoundZenKey() ?? getZenKey()
      if (keyInfo) cliProviderPrefix = `opencode-k${keyInfo.index + 1}`
    } catch { /* giữ native — SBF cũng chạy được qua native nếu không có key pool */ }
  } else {
    ensureOpenCodeAuth()
  }
  const cliModel = `${cliProviderPrefix}/${model}`

  console.log(`[OC-CLI] ${taskLabel} — spawn opencode run --model ${cliModel} (bin: ${cliBin})`)
  return new Promise<LLMResult | null>((resolve) => {
    // TASK 34 — PROMPT QUA STDIN (verified opencode v1.18.32 đọc stdin khi
    // không có message arg — test exit 0 trả lời đúng): (a) Windows giới hạn
    // command line ~32K chars — prompt TMO thường 30-100KB → truyền argv fail;
    // (b) npm Windows cài opencode.cmd shim — spawn .cmd bắt buộc shell:true,
    // chỉ an toàn khi args chứa HOÀN TOÀN flags (không có nội dung prompt).
    const args = [
      'run',
      '--model', cliModel,
      '--format', 'json',
    ]
    // TASK 33 — chế độ reasoning cao nhất qua --variant (CLI flag chính thống:
    // "model variant (provider-specific reasoning effort, e.g., high, max, minimal)").
    // Map cùng HTTP path: muse-spark=xhigh, space-bunny=max; model không có knob
    // (nemotron/lightning/mimo) → không truyền (truyền giá trị lạ bị CLI từ chối).
    const cliEffort = zenReasoningEffortForModel(model)
    if (cliEffort) args.push('--variant', cliEffort)
    const isCmdShim = /\.(cmd|bat)$/i.test(cliBin)
    const child = isCmdShim
      ? spawn(cliBin, args, {
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
          shell: true, // .cmd/.bat shim chỉ chạy được qua shell (Node spawn chặn trực tiếp)
        })
      : spawn(cliBin, args, {
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
    // TASK 34 — prompt qua stdin (xem comment khối args ở trên); đóng stdin
    // ngay sau write → signal non-interactive mode (prevent TTY wait)
    child.stdin?.on('error', () => { /* ignore EPIPE if child exits early */ })
    child.stdin?.write(fullPrompt)
    child.stdin?.end()

    let stdout = ''
    let stderr = ''
    // TASK 34 — raw output head (64KB đầu) để phát hiện error event FreeTierError
    // của CLI (event error xuất hiện sớm trong stream, trước text events)
    let rawHead = ''
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
      const chunkStr = chunk.toString()
      if (rawHead.length < 65536) rawHead += chunkStr
      stdout += chunkStr
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

      // ROUND-50 FIX (P3-ζ): đường CLI cùng leak marker (model nền MiniMax) —
      // strip content + reasoning tại nguồn, mirror đường HTTP.
      const content = stripProviderGarbleMarkers(contentParts.join('')).trim()
      const reasoning = stripProviderGarbleMarkers(reasoningParts.join('')).trim()

      if (!content && code !== 0) {
        // TASK 34 — các lỗi model-level dai dẳng từ CLI → mark cache để các lần
        // sau skip CLI thẳng failover (không tốn 5-10s spawn mỗi call):
        //   FreeTierError/RegionError/Insufficient = policy-level (TTL chuẩn
        //   15 phút); UnknownError "Unexpected server error" = model-level
        //   (vd muse-spark geo-block trả UnknownError — verified 2026-09-27)
        //   → TTL ngắn 5 phút (tự retry định kỳ phòng lỗi server tạm thời).
        //   Lỗi timeout/hang/spawn KHÔNG cache (có thể tạm thời).
        const raw = rawHead + '\n' + stderr
        if (raw.includes('FreeTierError') || raw.includes('free tier can only be used from within OpenCode')) {
          markZenFreeTierBlocked('cli', model, 'CLI nhận FreeTierError 403 (r74 BUG2-033: Zen đã chặn lại native provider cho model free ngoài SBF — policy toàn cục, không phải quota key/app-dir; model chuyển tiếp về ZEN FAILOVER)', 300_000)
        } else if (raw.includes('RegionError') || /not available in your region/i.test(raw)) {
          markZenFreeTierBlocked('cli', model, 'CLI nhận RegionError — model geo-block tại vùng máy chủ này')
        } else if (/Insufficient (account )?(funds|credits?)/i.test(raw)) {
          markZenFreeTierBlocked('cli', model, 'CLI nhận lỗi Insufficient funds — tài khoản không đủ credit cho model này')
        } else if (raw.includes('Unexpected server error') || raw.includes('"UnknownError"')) {
          markZenFreeTierBlocked('cli', model, 'CLI nhận UnknownError "Unexpected server error" (model-level — vd geo-block)', Math.min(ZEN_FREE_TIER_CACHE_MS, 300000))
        }
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
  /** TASK 34 — các cặp transport:model đang bị cache chặn free-tier (TTL 15 phút) */
  freeTierBlocked: string[]
} {
  const now = Date.now()
  const rateLimited = zenKey429Until.filter((t, i) => i < ZEN_API_KEYS.length && t > now).length
  // r74 — value là { until, reason } (không còn number thuần)
  const freeTierBlocked = [...zenFreeTierBlockedUntil.entries()]
    .filter(([, v]) => v.until > now)
    .map(([k]) => k)
  return {
    configured: ZEN_API_KEYS.length > 0,
    keyCount: ZEN_API_KEYS.length,
    availableKeys: ZEN_API_KEYS.length - rateLimited,
    rateLimitedKeys: rateLimited,
    freeTierBlocked,
    models: [
      'space-bunny-free',
      'nemotron-3-ultra-free',
      'muse-spark-1.3-contributor-free',
      'nemotron-3.5-lightning-free',
      'mimo-v2.6-flash-free',
    ],
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

  // ===== OPENCODE ZEN — LÕI DUY NHẤT CỦA AGENTS (TASK 33 — 2026-09-27) =====
  // USER DIRECTIVE: "Không dùng các model của NVIDIA NIM cho các tác vụ agents
  // nữa — riêng lõi embed tôi vẫn dùng của NVIDIA NIM; bỏ luôn cả z-ai."
  // Toàn bộ agent call (goal-loop, research team, code-team, smolab, chat
  // agents, self-direction...) route qua OpenCode Zen với model zen cấu hình
  // TỪNG AGENT (DB AgentProfile). DB cũ còn sót provider='nvidia' +
  // model NIM (kimi-k3/minimax/deepseek...) → normalize sang zen theo vai trò
  // (seed migration cũng sửa DB lúc boot — đây là lớp an toàn runtime cho row
  // chưa kịp migrate).
  if (!isZenConfigured()) {
    return {
      content: '',
      provider: 'zen',
      model,
      error: 'OpenCode Zen chưa cấu hình (ZEN_API_KEY_1/2 trong .env) — NIM đã ngừng dùng cho agents (Task 33), KHÔNG có fallback NIM',
    }
  }

  // ===== USER DIRECTIVE 2026-11-30 — KIMI-K3 (NIM) LÀ LỰA CHỌN AGENT TẠM THỜI =====
  // Chọn kimi-k3 (dropdown Smolab / AgentProfile / Omega factory) → route
  // THẬT qua NIM kimi-k3 (xoay vòng 4 key × 3 lần, circuit breaker tự trip
  // khi hang/429 — không normalize về space-bunny-free như các id NIM chết).
  // NIM 429 kéo dài / EOL kimi-k3 → fallback chuỗi Zen space-bunny-free phía
  // dưới (agent không chết — đúng tinh thần "tạm thời nếu kimi k3 sống được
  // thì giữ lại như 1 lựa chọn").
  if (model === KIMI_K3_NIM_ID) {
    const nimResult = await callModelWithKeyRotation(
      KIMI_K3_NIM_ID,
      prompt,
      systemPrompt,
      options,
      { taskLabel: `agent-nim:${KIMI_K3_NIM_ID}` },
    )
    if (nimResult && (nimResult.content || (nimResult.tool_calls && nimResult.tool_calls.length > 0))) {
      const tcCount = nimResult.tool_calls?.length ?? 0
      console.log(`[LLM] Agent dùng NIM ${KIMI_K3_NIM_ID} ✓ (${tcCount} tool_calls, ${nimResult.tokensUsed ?? 0} tokens)${options?.agentName ? ` — agent: ${options.agentName}` : ''}`)
      return nimResult
    }
    console.warn(`[LLM] Agent NIM ${KIMI_K3_NIM_ID} thất bại toàn chuỗi xoay key (429 kéo dài/EOL — user directive 2026-11-30: kimi-k3 tạm thời) → fallback chuỗi Zen space-bunny-free${options?.agentName ? ` — agent: ${options.agentName}` : ''}: ${String(nimResult?.error || 'null result').slice(0, 120)}`)
  }

  let zenModel = model
  if (provider !== 'zen' && model !== KIMI_K3_NIM_ID) {
    // Model NIM cũ (chứa '/') hoặc id lạ → map về model zen PHIÊN 7: space-bunny-free
    // cho TẤT CẢ agent (Task 37 — model free duy nhất mở cho oc_sk API key).
    // (kimi-k3 đã xử lý ở nhánh riêng phía trên — không rơi vào normalize này.)
    zenModel = isZenModelId(model) ? model : 'space-bunny-free'
    console.warn(`[LLM] Agent cấu hình provider "${provider}/${model}" không còn dùng cho agents (NIM matrix 2026-11-30 — chỉ kimi-k3 còn mở) → route Zen ${zenModel}${options?.agentName ? ` (agent: ${options.agentName})` : ''}`)
  }
  if (model === KIMI_K3_NIM_ID) {
    // kimi-k3 fail NIM → chạy chuỗi Zen với model chính space-bunny-free
    zenModel = isZenModelId(zenModel) ? zenModel : 'space-bunny-free'
  }

  // P6-M3 (§P6-M3, mục #15): softmax(τ) chọn điểm khởi đầu khi
  // RUNTIME_MODEL_POLICY=softmax (mặc định OFF — điểm dừng #5) — agent có
  // override tườ minh ← giữ model cấu hình. Failover chuỗi cũ bên dưới
  // GIỮ NGUYÊN TOÀN BỘ — softmax chỉ đổi điểm khởi đầu (zenModel).
  zenModel = await maybeApplySoftmaxModelPolicy(zenModel, options)

  // Zen HTTP (kèm reasoning_effort chế độ cao nhất — Task 33)
  let zen = await callZenProvider(prompt, systemPrompt, zenModel, options, `agent:${zenModel}`)
  // ROUND-3 FIX (2026-09-29 — quan sát vận hành vòng 3): timeout/abort → RETRY
  // 1 lần trước khi chuyển chuỗi. Bằng chứng dev.log ~07:2x: evaluator MEGATRON
  // abort 300s → NHẢY thẳng sang CLI (thiếu binary — Zen chặn CLI free-model
  // từ ~25-26/09) → failover model trùng model chính → toàn chuỗi chết sau
  // ĐÚNG 1 attempt, dù các key khác hoàn toàn khỏe (getZenKey round-robin tự
  // xoay key kế; sub-agent ghim key thì retry cùng key vẫn là 1 attempt mới).
  // Chỉ retry với lỗi thời gian (abort/timeout/ETIMEDOUT/ECONNRESET) — 429 đã
  // mark cooldown + 403/402 đã cache chặn, các lỗi đó chuỗi đằng sau xử lý.
  //
  // ROUND-5 FIX (2026-09-29 15:5x UTC — quan sát vận hành vòng 5): HTTP 5xx
  // (502/503/504...) cũng là lỗi TẠM THỜI — thêm vào điều kiện retry. Bằng
  // chứng dev.log 16:0x: "[ZEN] agent:space-bunny-free HTTP 503" (provider
  // quá tải thoáng qua) → KHÔNG khớp regex thời gian → không retry → CLI
  // thiếu binary → failover model trùng model chính (space-bunny-free) →
  // "thất bại toàn chuỗi" → chu kỳ 14 SENTINEL chết MẤT 26 tool calls dù cả
  // 3 key hoàn toàn khỏe (key bị 503 đã được mark cooldown 10s — getZenKey
  // round-robin tự né, retry sẽ sang key khác). 503 = quá tải tạm thời của
  // server; 1 retry trên key kế là thuốc đúng bệnh.
  // ROUND-7 FIX (2026-09-29 — item tồn đọng Nhiệm vụ 2 "reasoning starvation"):
  // Zen trả 200 nhưng 0 content (reasoning nuốt hết output — thực tế chu kỳ 21
  // SENTINEL: reasoning_tokens=1264, 0 chars) KHÔNG khớp regex thời gian/5xx
  // phía trên → KHÔNG retry → CLI (hồi đó thiếu binary) → failover model TRÙNG
  // space-bunny-free (bỏ qua nhánh :4984) → TOÀN CHUỖI CHẾT sau 1 attempt, mất
  // nguyên chu kỳ dù chỉ là starvation thoáng qua. Giờ: empty-response được
  // retry 1 lần — reasoning starvation thường thoáng qua (non-deterministic),
  // key round-robin tự xoay key kế; lần retry hạ effort 1 nấc (max→high) nếu
  // caller không chỉ định rõ — phá vỡ pattern "reasoning nuốt sạch budget"
  // trong khi vẫn giữ chất lượng suy luận cao.
  //
  // ROUND-50 FIX (P1-α r49): 1 retry effort→high TẠI SAI THUỐC — bằng chứng
  // mission Linh Sickyx r49: ALISTA #1 chết "failed" + cycle 3 error vì
  // empty-response lặp 2 lần liên tiếp (200 OK + finish_reason=stop + 0 content,
  // reasoning_tokens 251-457); CLI không cài (fallback chết) + failover model
  // TRÙNG model chính (space-bunny-free) → toàn chuỗi chết. LADDER 3 nấc cho
  // empty-response: effort high → medium → low (step-down thật sự đấm xuyên
  // pattern "reasoning nuốt budget" — effort thấp ⇒ reasoning ngắn ⇒ còn chỗ
  // cho content) + backoff ngắn từ nấc 2 (để provider thoáng hồi). Lỗi
  // transient (timeout/5xx): giữ 1 retry như cũ (key round-robin đã xoay key).
  let zenTransientRetried = false
  let zenEmptyRetries = 0
  while (
    zen && !zen.content && !(zen.tool_calls && zen.tool_calls.length > 0)
    && /abort|timeout|etimedout|econnreset|socket hang up|HTTP 5\d\d|Zen empty response/i.test(zen.error ?? '')
  ) {
    const isEmptyResponse = /Zen empty response/i.test(zen.error ?? '')
    if (!isEmptyResponse) {
      // Transient (timeout/abort/5xx): 1 retry — hành vi cũ giữ nguyên
      if (zenTransientRetried) break
      zenTransientRetried = true
      console.warn(`[LLM] Agent Zen ${zenModel} lỗi tạm thời (thời gian/5xx — lần 1) — retry 1 lần key kế: ${String(zen.error).slice(0, 120)}`)
      zen = await callZenProvider(prompt, systemPrompt, zenModel, options, `agent-retry:${zenModel}`)
      continue
    }
    // Empty response (reasoning starvation): ladder 3 nấc
    if (zenEmptyRetries >= 3) break
    zenEmptyRetries++
    // Nấc 1: tôn trọng effort caller chỉ định (nếu có) — không phải thì high
    // Nấc 2/3: step-down cưỡng bức medium → low (đấm xuyên starvation)
    const ladderEffort = zenEmptyRetries === 1
      ? (options?.reasoningEffort || 'high')
      : (zenEmptyRetries === 2 ? 'medium' : 'low')
    const retryOpts = { ...options, reasoningEffort: ladderEffort }
    const backoffMs = zenEmptyRetries >= 2 ? zenEmptyRetries * 1500 : 0
    if (backoffMs > 0) await new Promise(r => setTimeout(r, backoffMs))
    console.warn(`[LLM] Agent Zen ${zenModel} EMPTY RESPONSE (reasoning starvation — 0 content, nấc ${zenEmptyRetries}/3) — retry effort→${ladderEffort}${backoffMs ? ` + backoff ${backoffMs}ms` : ''}: ${String(zen.error).slice(0, 120)}`)
    zen = await callZenProvider(prompt, systemPrompt, zenModel, retryOpts, `agent-retry${zenEmptyRetries}:${zenModel}`)
  }
  if (zen && (zen.content || (zen.tool_calls && zen.tool_calls.length > 0))) {
    const tcCount = zen.tool_calls?.length ?? 0
    console.log(`[LLM] Agent dùng Zen ${zenModel} ✓ (${tcCount} tool_calls, ${zen.tokensUsed ?? 0} tokens)`)
    return zen
  }
  // Zen HTTP failed (FreeTierError 403 / 429 / 5xx) → try OpenCode CLI provider
  // (free models chỉ gọi được qua CLI, không qua HTTP API)
  console.warn(`[LLM] Agent Zen HTTP ${zenModel} thất bại — thử OpenCode CLI provider: ${(zen?.error || 'unknown').slice(0, 100)}`)
  const cliResult = await callOpenCodeCLIProvider(prompt, systemPrompt, zenModel, options, `agent:${zenModel}`)
  if (cliResult && (cliResult.content || (cliResult.tool_calls && cliResult.tool_calls.length > 0))) {
    const tcCount = cliResult.tool_calls?.length ?? 0
    console.log(`[LLM] Agent dùng OpenCode CLI ${zenModel} ✓ (${tcCount} tool_calls, ${cliResult.tokensUsed ?? 0} tokens)`)
    return cliResult
  }
  // 2026-10-27 (phiên 4) — ZEN MODEL FAILOVER: model zen cấu hình fail cả
  // HTTP + CLI (vd muse-spark-1.3-contributor-free bị RegionError geo-block
  // trên server ngoài VN; chạy trực tiếp OK ở môi trường local VN của user)
  // → thử 1 model zen dự phòng KHÁC (default space-bunny-free — stealth model
  // ẩn danh, ctx 1M, zero-retention; CHÍNH THỨC là model của 2 agent debug
  // SENTINEL/LISMA từ Task 33, đồng thời là safety net cho agent khác) trước
  // khi trả lỗi. Giữ agents sống ngay cả khi model chính không khả dụng ở
  // vùng này — model cấu hình vẫn là model chính (agent dùng model dự phòng
  // chỉ khi model chính thất bại hoàn toàn, có log rõ ràng để truy vết).
  const zenFailoverModel = process.env.ZEN_FAILOVER_MODEL?.trim() || 'space-bunny-free'
  if (zenModel !== zenFailoverModel) {
    console.warn(`[LLM] Agent Zen ${zenModel} thất bại cả HTTP + CLI — thử ZEN FAILOVER model ${zenFailoverModel}`)
    const foHttp = await callZenProvider(prompt, systemPrompt, zenFailoverModel, options, `agent-failover:${zenFailoverModel}`)
    if (foHttp && (foHttp.content || (foHttp.tool_calls && foHttp.tool_calls.length > 0))) {
      console.log(`[LLM] Agent dùng ZEN FAILOVER ${zenFailoverModel} ✓ (model chính ${zenModel} không khả dụng ở vùng này) — ${foHttp.tool_calls?.length ?? 0} tool_calls`)
      return foHttp
    }
    const foCli = await callOpenCodeCLIProvider(prompt, systemPrompt, zenFailoverModel, options, `agent-failover:${zenFailoverModel}`)
    if (foCli && (foCli.content || (foCli.tool_calls && foCli.tool_calls.length > 0))) {
      console.log(`[LLM] Agent dùng ZEN FAILOVER (CLI) ${zenFailoverModel} ✓ (model chính ${zenModel} không khả dụng ở vùng này) — ${foCli.tool_calls?.length ?? 0} tool_calls`)
      return foCli
    }
    console.warn(`[LLM] ZEN FAILOVER ${zenFailoverModel} cũng thất bại — sang LAST RESORT (r73 BUG2-018)`)
  }
  // r73 (BUG2-018 — kiến trúc failover chéo model trong free tier): model
  // chính + failover đều chết (đặc biệt khi model chính == space-bunny-free ==
  // failover → rung failover bị skip) → thử lần lượt các model free KHÁC qua
  // CLI native (HTTP bị Zen chặn free-tier với mọi model ngoài SBF — bằng
  // chứng 2026-10-09: nemotron/ling/mimo HTTP = FreeTierError 403, CLI OK).
  // Pool mặc định = các model ĐÃ VERIFY battery r73 (coding/reasoning/agentic).
  // Chỉ thử ĐƯỜNG CLI (HTTP đã biết chết — không đốt timeout mạng lại). Agent
  // chỉ chết khi TOÀN BỘ pool free chết. Override bằng env ZEN_LAST_RESORT_MODELS.
  for (const lrModel of parseZenLastResortModels(process.env.ZEN_LAST_RESORT_MODELS, zenModel, zenFailoverModel)) {
    console.warn(`[LLM] LAST RESORT (r73 BUG2-018): model chính ${zenModel} + failover ${zenFailoverModel} đều thất bại — thử model free CLI-native ${lrModel}...`)
    const lrCli = await callOpenCodeCLIProvider(prompt, systemPrompt, lrModel, options, `agent-last-resort:${lrModel}`)
    if (lrCli && (lrCli.content || (lrCli.tool_calls && lrCli.tool_calls.length > 0))) {
      console.log(`[LLM] Agent dùng LAST RESORT ${lrModel} ✓ (${lrCli.tool_calls?.length ?? 0} tool_calls — model chính ${zenModel} chết, agent vẫn sống)`)
      return lrCli
    }
  }
  // TASK 33: hết chuỗi Zen (HTTP → CLI → failover → last-resort) → trả lỗi rõ
  // ràng cho caller nhìn thấy nguyên nhân thật. KHÔNG còn fallback NIM kimi-k3
  // chain — NIM chỉ còn vai trò lõi embed (embeddings.ts).
  const lastResortList = parseZenLastResortModels(process.env.ZEN_LAST_RESORT_MODELS, zenModel, zenFailoverModel).join('/')
  const lastError = zen?.error || cliResult?.error || 'unknown'
  console.warn(`[LLM] Agent Zen ${zenModel} thất bại toàn chuỗi (HTTP + CLI${zenModel !== zenFailoverModel ? ` + failover ${zenFailoverModel}` : ''} + last-resort ${lastResortList}) — trả lỗi (NIM removed): ${String(lastError).slice(0, 200)}`)
  return {
    content: '',
    provider: 'zen',
    model: zenModel,
    error: `Zen model "${zenModel}" thất bại toàn chuỗi (HTTP + CLI${zenModel !== zenFailoverModel ? ` + failover ${zenFailoverModel}` : ''} + last-resort): ${String(lastError).slice(0, 300)} — NIM đã ngừng dùng cho agents (Task 33)`,
  }
}

/**
 * r73 (BUG2-018) — parse danh sách model LAST-RESORT (pure — export cho test).
 *  - env ZEN_LAST_RESORT_MODELS = "model-a, model-b,..." (override); thiếu/rỗng
 *    → pool mặc định đã verify battery r73.
 *  - LOẠI model chính + model failover (đã thử ở rung trên — không lặp lại).
 *  - Cap 3 model/lần (mỗi model 1 đường CLI ≤ OPENCODE_CLI_TIMEOUT_MS — chống
 *    đốt 15+ phút khi cả pool chết).
 */
export function parseZenLastResortModels(envRaw: string | undefined, ...exclude: string[]): string[] {
  const defaults = ['ling-3.1-flash-free', 'mimo-v2.6-flash-free', 'big-pickle']
  const excluded = new Set(exclude.map(m => (m || '').trim()).filter(m => m.length > 0))
  const raw = (envRaw || '').trim()
  const pool = (raw ? raw.split(',') : defaults)
    .map(m => m.trim())
    .filter(m => m.length > 0 && !excluded.has(m))
  return pool.slice(0, 3)
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
