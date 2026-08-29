/**
 * Feature Flags — Centralized reader for v2.1 staged rollout.
 *
 * All new tools ship with feature flags OFF by default (D11 principle).
 * Flip flags in `.env` to enable per-phase rollout:
 *
 *   Phase 1a: ENABLE_SHELL_TOOL, ENABLE_TODO_TOOL, ENABLE_QUALITY_GATE
 *   Phase 1b: ENABLE_WEB_UNIFIED, ENABLE_GATEWAY_TOOLS
 *   Phase 1c: ENABLE_NATIVE_FC
 *   Phase 2:   ENABLE_FILE_*
 *   Phase 3:   ENABLE_LSP_*, ENABLE_BROWSER_*, ENABLE_LINT, ENABLE_TYPE_CHECK, ENABLE_TEST_COVERAGE, ENABLE_DB_QUERY, ENABLE_MCP_CALL
 *   Phase 4:   ENABLE_AUTO_*, ENABLE_PLAN_MODE, ENABLE_CRON_TOOL
 *   Phase 5:   ENABLE_MASTER_ORCHESTRATOR, ENABLE_SESSION_RESUME
 *   Phase 4 SMOLAB (retrieval quality suite): ENABLE_HYBRID_SEARCH,
 *               ENABLE_MMR, ENABLE_RERANKER, ENABLE_SEMANTIC_ENTITY_SEARCH
 *   Phase 4 SMOLAB (Task C — query understanding): ENABLE_QUERY_REWRITE
 *
 * Usage:
 *   import { isFlagEnabled, flagMode } from '@/lib/feature-flags'
 *
 *   if (isFlagEnabled('ENABLE_SHELL_TOOL')) { ... }
 *
 *   const mode = flagMode('ENABLE_QUALITY_GATE', ['off', 'warn', 'strict']) // → 'off' default
 *   if (mode === 'warn') { ... }
 *
 * See: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 12
 */

const DEFAULTS: Record<string, string> = {
  // Phase 1a
  // ENABLE_SHELL_TOOL mặc định true (user request 2026-08-28): agent phải chạy được
  // lệnh shell/terminal trong workspace user chọn. Update 2026-08-29 (user request):
  // KHÔNG chặn sudo/rm -rf /, KHÔNG khóa cwd trong workspace root — user tự chịu
  // trách nhiệm. Chỉ giữ timeout 5-10 phút + output truncation.
  ENABLE_SHELL_TOOL: 'true',
  // ENABLE_TODO_TOOL mặc định true (user request 2026-08-29): agent phải tự chia nhỏ
  // được task phức tạp + UI "Agent Tasks" hiển thị tiến độ long-running task.
  // Tools đã DB-backed (SQLite Todo model) + có API GET /api/todos cho UI polling.
  ENABLE_TODO_TOOL: 'true',
  ENABLE_QUALITY_GATE: 'off', // off | warn | strict

  // Phase 1b
  // ENABLE_WEB_UNIFIED mặc định true (user bug report 2026-08-30): web_search/
  // web_fetch đã multi-strategy (Tavily → Serper → SDK / Jina → SDK) nên tool
  // hoạt động cả khi chạy LOCAL không có SDK z-ai (SDK chỉ là fallback cuối
  // trong sandbox Z.ai). Trước đây default false khiến 2 tool này TẮT hoàn toàn
  // trên máy local dù user đã cấu hình TAVILY/SERPER/JINA keys trong .env.
  ENABLE_WEB_UNIFIED: 'true',
  ENABLE_GATEWAY_TOOLS: 'off', // off | phase-1b | full

  // Phase 1c
  ENABLE_NATIVE_FC: 'off', // off | dual | strict

  // Phase 2 (file ops already implemented in commit 337f56f — flag still useful for runtime gating)
  // Per-tool flags per spec line 217 of FULLSTACK_CAPABILITY_PLAN_V2.md:
  // "each tool ENABLE_<TOOL> off by default, flip per acceptance test".
  // We default to `true` here for backward compat (tools were already shipped before flags added),
  // operators can flip individual tools off without disabling the whole suite.
  ENABLE_FILE_OPS: 'true', // blanket (master switch — set false to disable ALL file tools)
  ENABLE_FILE_READ: 'true',
  ENABLE_FILE_EDIT: 'true',
  ENABLE_FILE_MULTI_EDIT: 'true',
  // 21-d: file_write — tạo file mới / ghi đè / APPEND (continuation cho file
  // lớn). Default true cùng nhóm file ops (đã ship active từ task này).
  ENABLE_FILE_WRITE: 'true',
  ENABLE_FILE_DELETE: 'true',
  ENABLE_FILE_LIST: 'true',
  ENABLE_FILE_GREP: 'true',
  ENABLE_RUN_TESTS: 'true',
  ENABLE_GIT_COMMIT: 'true',

  // Phase 3 (NEW in Task 8 — code intelligence + MCP; all default false per spec
  // Part 12 "new tools default false" — flip to true in .env after smoke test passes)
  ENABLE_LSP_DIAGNOSTICS: 'false',
  ENABLE_BROWSER_SCREENSHOT: 'false',
  ENABLE_LINT: 'false',
  ENABLE_TYPE_CHECK: 'false',
  ENABLE_TEST_COVERAGE: 'false',
  ENABLE_DB_QUERY: 'false',
  // ENABLE_MCP_CALL mặc định true (user request 2026-08-29): agents phải tự
  // enumerate được MCP servers (mcp_list_servers) và gọi mcp_call. Bridge có
  // permission prompt per-server nên gọi server chưa duyệt chỉ trả
  // requiresPermission — an toàn khi bật mặc định.
  ENABLE_MCP_CALL: 'true',

  // Phase 4
  ENABLE_AUTO_CHECKPOINT: 'false',
  ENABLE_AUTO_RESTORE: 'off', // off | warn | strict
  ENABLE_STAGING_BRANCH: 'false',
  ENABLE_HUMAN_REVIEW: 'false',
  ENABLE_PLAN_MODE: 'false',
  ENABLE_CRON_TOOL: 'false',

  // Phase 5
  ENABLE_MASTER_ORCHESTRATOR: 'false',
  ENABLE_REAL_DELEGATE: 'false',
  ENABLE_SESSION_RESUME: 'false',

  // SUB-AGENT DELEGATION (user request 2026-09-08): delegate_task tool cho
  // goal loop — agent (vd Omega) gọi Code Team chuyên trách, sub-agent chạy
  // mini ReAct loop có budget riêng, parent nhận báo cáo nén (context
  // isolation). Default TRUE: an toàn vì (a) whitelist per-agent — chỉ agent
  // có 'delegate_task' trong tools[] mới gọi được, (b) depth-guard chống đệ
  // quy, (c) token budget riêng mỗi lần delegate.
  ENABLE_SUBAGENT_DELEGATE: 'true',

  // Phase 4 SMOLAB — Retrieval quality suite (kb-access.ts searchChunks pipeline +
  // searchEntitiesForUser). Hybrid BM25+RRF, MMR and semantic entity search ship ON
  // by default: they are pure in-process upgrades with graceful degradation (no
  // external services, no collection migration, lexical/vector fallbacks intact).
  // The cross-encoder reranker ships OFF — it needs a local rerank service
  // (see src/lib/kb-routing/reranker.ts header for hosting instructions).
  ENABLE_HYBRID_SEARCH: 'true', // Prop 3.7 — in-process BM25+RRF fusion over dense candidates
  ENABLE_MMR: 'true', // Prop 3.8 — MMR diversity rerank (uses pre-fetched Qdrant vectors)
  ENABLE_RERANKER: 'false', // Prop 3.6 — external cross-encoder reranker client (requires RERANKER_ENDPOINT service)
  ENABLE_SEMANTIC_ENTITY_SEARCH: 'true', // Prop 3.11 — vector entity search with lexical fallback

  // Phase 4 SMOLAB Task C — Prop 3.9: query rewrite + HyDE before the KB pre-search
  // in the chat route (src/app/api/openclaw/chat/route.ts). Costs up to 3 LLM calls
  // (+1-2s latency per query) — mitigated by a 200-entry/10-min in-memory cache in
  // src/lib/kb-routing/query-rewriter.ts. Default OFF: opt-in for latency-sensitive
  // deployments; flip to true once retrieval quality matters more than p95 latency.
  ENABLE_QUERY_REWRITE: 'false',

  // Phase 4 SMOLAB (user request 2026-09-05 — kiến trúc truy vấn Leiden cho lõi
  // embed): community-aware retrieval. Leiden chạy trên entity graph Neo4j →
  // community summaries embed vào Qdrant (theopus_communities) → query-time
  // vector search song song với chunks. Default true nhưng search trả []
  // cho tới khi detection chạy lần đầu (GET /api/query?action=community-detect
  // hoặc lazy auto-detect ở query đầu tiên) → zero-impact khi chưa bật.
  ENABLE_COMMUNITY_SEARCH: 'true',
}

/**
 * Read the raw string value of a flag, falling back to its default.
 * Flags are read from `process.env` so they can be flipped at deploy time.
 */
export function flagValue(name: string): string {
  const envVal = process.env[name]
  if (envVal !== undefined && envVal !== '') return envVal
  return DEFAULTS[name] ?? 'false'
}

/**
 * Check whether a boolean feature flag is enabled.
 * Accepts: 'true', '1', 'yes' (case-insensitive).
 */
export function isFlagEnabled(name: string): boolean {
  const v = flagValue(name).toLowerCase().trim()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/**
 * Read a mode-style flag and validate it against an allowlist.
 * Falls back to the default value (or the first allowed option) if invalid.
 *
 * Example:
 *   flagMode('ENABLE_QUALITY_GATE', ['off', 'warn', 'strict'])  // → 'off' default
 */
export function flagMode(name: string, allowed: string[]): string {
  const v = flagValue(name).toLowerCase().trim()
  if (allowed.includes(v)) return v
  const fallback = DEFAULTS[name]
  if (fallback && allowed.includes(fallback)) return fallback
  return allowed[0]
}

