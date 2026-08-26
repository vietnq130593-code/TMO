/**
 * GET /api/tools — List ALL tools (custom + local + gateway) with metadata
 *
 * Query params:
 *   source=custom|local|gateway|all   (default: all)
 *   enabled=true|false                (default: all — only applies to custom tools)
 *   category=...                      (filter by category)
 *
 * Merges custom tools from DB with existing tool data from the openclaw tools catalog.
 * Custom tools are deduplicated against local/gateway tools.
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getAllCustomTools } from '@/lib/custom-tool-registry'
import { tavilyKeyPool, jinaKeyPool, serperKeyPool } from '@/lib/service-key-pool'

// FIX (P2 broken import): the route previously imported GATEWAY_TOOL_REGISTRY,
// SESSION_CONTEXT_TOOLS, HTTP_ACCESSIBLE_TOOLS from '@/lib/openclaw' — but those
// exports NEVER existed in openclaw.ts (verified across all git history). The
// route failed at runtime with a module-resolution error. Defined inline below
// from the 36-tool catalog in mini-services/gateway-bridge/index.ts.

const SESSION_CONTEXT_TOOLS = new Set([
  'x_search', 'exec', 'read', 'write', 'edit', 'apply_patch', 'code_execution',
  'process', 'sessions_spawn', 'sessions_send', 'cron', 'heartbeat_respond',
  'gateway', 'nodes', 'update_plan', 'image', 'image_generate', 'music_generate', 'video_generate',
])

const HTTP_ACCESSIBLE_TOOLS = new Set([
  'web_search', 'web_fetch', 'memory_search', 'memory_get', 'browser', 'canvas',
  'sessions_list', 'sessions_history', 'session_status', 'sessions_yield',
  'agents_list', 'message', 'tts', 'skill_workshop', 'create_goal', 'get_goal', 'update_goal',
])

const GATEWAY_TOOL_REGISTRY = [
  // HTTP-accessible tools
  { name: 'web_search', category: 'Web', description: 'AI-optimized web search' },
  { name: 'web_fetch', category: 'Web', description: 'Fetch + extract content from a URL' },
  { name: 'memory_search', category: 'Memory', description: 'Search agent memories' },
  { name: 'memory_get', category: 'Memory', description: 'Get a specific memory by ID' },
  { name: 'browser', category: 'Web', description: 'Headless browser automation' },
  { name: 'canvas', category: 'UI', description: 'Render canvas/image' },
  { name: 'sessions_list', category: 'Session', description: 'List gateway sessions' },
  { name: 'sessions_history', category: 'Session', description: 'Get session history' },
  { name: 'session_status', category: 'Session', description: 'Get session status' },
  { name: 'sessions_yield', category: 'Session', description: 'Yield session control' },
  { name: 'agents_list', category: 'Agent', description: 'List available agents' },
  { name: 'message', category: 'Agent', description: 'Send a message to an agent/session' },
  { name: 'tts', category: 'AI', description: 'Text-to-speech synthesis' },
  { name: 'skill_workshop', category: 'Skill', description: 'Skill marketplace workshop' },
  { name: 'create_goal', category: 'Planning', description: 'Create a new goal/task' },
  { name: 'get_goal', category: 'Planning', description: 'Get a goal/task by ID' },
  { name: 'update_goal', category: 'Planning', description: 'Update goal/task status' },
  // Session-context / bridge-only tools
  { name: 'x_search', category: 'Web', description: 'Search X (Twitter)' },
  { name: 'exec', category: 'Code', description: 'Execute shell command (session context)' },
  { name: 'read', category: 'File', description: 'Read file (session context)' },
  { name: 'write', category: 'File', description: 'Write file (session context)' },
  { name: 'edit', category: 'File', description: 'Edit file (session context)' },
  { name: 'apply_patch', category: 'File', description: 'Apply unified diff patch (session context)' },
  { name: 'code_execution', category: 'Code', description: 'Execute code in sandbox (session context)' },
  { name: 'process', category: 'Code', description: 'Manage processes (session context)' },
  { name: 'sessions_spawn', category: 'Session', description: 'Spawn a new session (session context)' },
  { name: 'sessions_send', category: 'Session', description: 'Send message to a session (session context)' },
  { name: 'cron', category: 'Automation', description: 'Manage cron jobs (session context)' },
  { name: 'heartbeat_respond', category: 'Automation', description: 'Respond to heartbeat (session context)' },
  { name: 'gateway', category: 'Gateway', description: 'Gateway introspection (session context)' },
  { name: 'nodes', category: 'Gateway', description: 'List gateway nodes (session context)' },
  { name: 'update_plan', category: 'Planning', description: 'Update execution plan (session context)' },
  { name: 'image', category: 'AI', description: 'Process image (session context)' },
  { name: 'image_generate', category: 'AI', description: 'Generate image (session context)' },
  { name: 'music_generate', category: 'AI', description: 'Generate music (session context)' },
  { name: 'video_generate', category: 'AI', description: 'Generate video (session context)' },
]

export const dynamic = 'force-dynamic'

const BRIDGE_URL = process.env.OPENCLAW_BRIDGE_URL || 'http://127.0.0.1:18791'

// Local tool definitions (mirrored from /api/openclaw/tools for merging)
const LOCAL_TOOLS = [
  {
    name: 'opencode',
    category: 'Code',
    description: 'Read/write files, execute terminal commands. Used by Code Team for code implementation.',
    source: 'local' as const,
    dangerous: true,
    implemented: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'knowledge_search',
    category: 'Knowledge',
    description: 'Semantic search in Knowledge Base (Qdrant + Neo4j). All agents can use.',
    source: 'local' as const,
    dangerous: false,
    implemented: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'knowledge_graph',
    category: 'Knowledge',
    description: 'Query Neo4j graph with Cypher (read-only MATCH). All agents can use.',
    source: 'local' as const,
    dangerous: false,
    implemented: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'knowledge_write',
    category: 'Knowledge',
    description: 'Write entity/relationship to Knowledge Base. Use with caution.',
    source: 'local' as const,
    dangerous: true,
    implemented: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'tavily',
    category: 'Web',
    description: 'Deep web search AI-optimized. Returns results with summaries + answer.',
    source: 'local' as const,
    dangerous: false,
    implemented: true,
    apiKeyEnv: 'TAVILY_API_KEY_1..4',
    hasApiKey: tavilyKeyPool.hasKeys(),
  },
  {
    name: 'serper',
    category: 'Web',
    description: 'Google Search API. Returns organic results with titles, snippets, links.',
    source: 'local' as const,
    dangerous: false,
    implemented: true,
    apiKeyEnv: 'SERPER_API_KEY_1..4',
    hasApiKey: serperKeyPool.hasKeys(),
  },
  {
    name: 'jina',
    category: 'Web',
    description: 'Web page reader. Reads content from URL.',
    source: 'local' as const,
    dangerous: false,
    implemented: true,
    apiKeyEnv: 'JINA_API_KEY_1..2',
    hasApiKey: jinaKeyPool.hasKeys(),
  },
  // ===== P0: dev tools (file ops + tests + git) =====
  { name: 'file_edit', category: 'File', description: 'Sửa file bằng exact string replace (atomic, error trên 0/>1 match). Ưu tiên dùng thay vì ghi đè cả file.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'file_delete', category: 'File', description: 'Xóa file/thư mục (có dry_run + guard chống xóa root).', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'file_list', category: 'File', description: 'List thư mục (tree depth 1-5, tự bỏ node_modules/.next/.git).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'grep', category: 'Search', description: 'Tìm nội dung file bằng regex (content/files/count modes).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'run_tests', category: 'Test', description: 'Chạy test suite (autodetect bun/vitest/jest/pytest, 5min timeout, parse pass/fail).', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'git_commit', category: 'Git', description: 'Commit scoped paths (không push). Dùng temp file cho message.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: '', hasApiKey: true },
  // ===== P1: diagnostics + planning + synthesis + processes + packages =====
  { name: 'get_diagnostics', category: 'Code', description: 'Type-check + lint diagnostics (tsc, file:line:col).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'decompose_task', category: 'Planning', description: 'Phân tách goal thành 3-7 subtasks DAG (LLM-assisted).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'create_task', category: 'Planning', description: 'Tạo task trong task store (assignee/priority/deps).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'update_task', category: 'Planning', description: 'Cập nhật status/notes của task.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'get_plan', category: 'Planning', description: 'Đọc task board + status breakdown.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'summarize', category: 'Synthesis', description: 'Tóm tắt file/text (LLM-assisted, purpose/points/risks).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'synthesize', category: 'Synthesis', description: 'Tổng hợp nhiều sources thành 1 báo cáo (conflicts + open questions).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'run_bg', category: 'Process', description: 'Chạy command nền (dev server/watcher), trả processId.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'read_output', category: 'Process', description: 'Poll output của background process (incremental).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'kill_process', category: 'Process', description: 'Kill background process by ID hoặc port.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'manage_packages', category: 'Package', description: 'bun add/remove/install/update (2min timeout).', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: '', hasApiKey: true },
  // ===== Phase 6 (rebuild): AI preview tools =====
  { name: 'start_preview', category: 'Preview', description: 'Start dev server cho active workspace (auto-detect framework, free port 3005+, per-root log + SSE stream). UI tự mở Preview panel.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: '', hasApiKey: true },
  { name: 'stop_preview', category: 'Preview', description: 'Stop dev server đang chạy cho 1 workspace root (idempotent — nothing-running vẫn success).', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: '', hasApiKey: true },
  // ===== P2: gateway proxy =====
  { name: 'gateway_tool', category: 'Gateway', description: 'Proxy tới 1 trong 36 gateway-bridge tools (web_search, exec, read, write, browser...).', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: '', hasApiKey: true },
  // ===== v2.1 Phase 1a: shell + todo (Claude Code parity) =====
  { name: 'shell', category: 'Shell', description: 'Bash (5min timeout, allow metacharacters; cwd mặc định workspace root, absolute OK; không chặn lệnh). Flag: ENABLE_SHELL_TOOL.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_SHELL_TOOL', hasApiKey: true },
  { name: 'todo_write', category: 'Planning', description: 'Claude Code-style batch upsert task list. Flag: ENABLE_TODO_TOOL.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_TODO_TOOL', hasApiKey: true },
  { name: 'todo_read', category: 'Planning', description: 'Đọc task list với status breakdown. Flag: ENABLE_TODO_TOOL.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_TODO_TOOL', hasApiKey: true },
  // ===== v2.1 Phase 1b.1: unified web (consolidate tavily/serper/jina) =====
  { name: 'web_search', category: 'Web', description: 'Unified web search (Tavily→Serper→z-ai-sdk). Flag: ENABLE_WEB_UNIFIED.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_WEB_UNIFIED', hasApiKey: true },
  { name: 'web_fetch', category: 'Web', description: 'Unified web page reader (Jina→z-ai-sdk). Flag: ENABLE_WEB_UNIFIED.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_WEB_UNIFIED', hasApiKey: true },
  // ===== v2.1 Phase 1b.2: P0 first-class gateway tools (proxy via 18791) =====
  { name: 'gateway_exec', category: 'Gateway', description: 'Execute shell command qua Gateway bridge. Flag: ENABLE_GATEWAY_TOOLS=phase-1b.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_GATEWAY_TOOLS', hasApiKey: true },
  { name: 'gateway_read', category: 'File', description: 'Read file qua Gateway bridge. Flag: ENABLE_GATEWAY_TOOLS=phase-1b.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_GATEWAY_TOOLS', hasApiKey: true },
  { name: 'gateway_write', category: 'File', description: 'Write file qua Gateway bridge. Flag: ENABLE_GATEWAY_TOOLS=phase-1b.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_GATEWAY_TOOLS', hasApiKey: true },
  { name: 'gateway_edit', category: 'File', description: 'Edit file (exact string replace) qua Gateway bridge. Flag: ENABLE_GATEWAY_TOOLS=phase-1b.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_GATEWAY_TOOLS', hasApiKey: true },
  { name: 'gateway_apply_patch', category: 'File', description: 'Apply unified diff patch qua Gateway bridge. Flag: ENABLE_GATEWAY_TOOLS=phase-1b.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_GATEWAY_TOOLS', hasApiKey: true },
  // ===== v2.1 Phase 3 — Code Intelligence + MCP (spec lines 223-242) =====
  { name: 'lsp_diagnostics', category: 'Code', description: 'LSP diagnostics (tsc --noEmit + opencode-server /lsp/diagnostics). Phase 3.1 wire-existing. Flag: ENABLE_LSP_DIAGNOSTICS.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_LSP_DIAGNOSTICS', hasApiKey: true },
  { name: 'browser_screenshot', category: 'Browser', description: 'Chụp screenshot URL (Playwright headless chromium) → base64 PNG. Tùy chọn full_page, viewport, wait_until, wait_ms, selector. Flag: ENABLE_BROWSER_SCREENSHOT.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_BROWSER_SCREENSHOT', hasApiKey: true },
  { name: 'lint', category: 'Code', description: 'ESLint --format json structured parser. Trả {errorCount, warningCount, results:[{file,line,column,severity,ruleId,message}]}. Cap max_results (default 100). Flag: ENABLE_LINT.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_LINT', hasApiKey: true },
  { name: 'type_check', category: 'Code', description: 'tsc --noEmit parser (file:line:col + TSxxxx code). Tùy chọn path filter. Flag: ENABLE_TYPE_CHECK.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_TYPE_CHECK', hasApiKey: true },
  { name: 'test_coverage', category: 'Test', description: 'bun test --coverage parser. Trả {totalCoverage:{functions,lines,branches}, files:[{path,coverage,uncoveredLines}], testFailures}. Flag: ENABLE_TEST_COVERAGE.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_TEST_COVERAGE', hasApiKey: true },
  { name: 'db_query', category: 'Database', description: 'Read-only SQL query (Prisma $queryRawUnsafe). STRICT READ-ONLY GUARD reject write keywords + multi-statement + PRAGMA. Trả {rows, rowCount, truncated, sql}. Flag: ENABLE_DB_QUERY.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_DB_QUERY', hasApiKey: true },
  { name: 'mcp_call', category: 'MCP', description: 'MCP bridge call (filesystem/github/postgres/puppeteer + auto-discovered). First-use permission prompt (D10 pattern). Phase 3 stub — mock impl, real subprocess deferred Phase 5. Flag: ENABLE_MCP_CALL.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_MCP_CALL', hasApiKey: true },
  // ===== v2.1 Phase 4.5 — exit_plan_mode (NEW — Claude Code parity) =====
  { name: 'exit_plan_mode', category: 'Planning', description: 'Phase 4.5 — Claude Code parity. Agent emits plan + target files + risk assessment; workflow pauses for user approval (via /api/openclaw/plan-mode). Available to TL (APEX) + G3 (CATALYST) only. Flag: ENABLE_PLAN_MODE.', source: 'local' as const, dangerous: false, implemented: true, apiKeyEnv: 'ENABLE_PLAN_MODE', hasApiKey: true },
  // ===== v2.1 Phase 4.6 — cron (NEW — Z.ai Code parity) =====
  { name: 'cron', category: 'Schedule', description: 'Phase 4.6 — Z.ai Code parity. Schedule recurring/one-time agent tasks. Action: create|list|delete|run. Schedule kinds: one_time|cron|fixed_rate. Dedup via jobHash. Retries max 3 with exponential backoff. Available to TL (APEX) + G3 (CATALYST) only. Mini-service cron-scheduler (port 3004) executes due jobs. Flag: ENABLE_CRON_TOOL.', source: 'local' as const, dangerous: true, implemented: true, apiKeyEnv: 'ENABLE_CRON_TOOL', hasApiKey: true },
]

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const sourceFilter = searchParams.get('source') || 'all'
    const enabledFilter = searchParams.get('enabled')
    const categoryFilter = searchParams.get('category')

    // ===== Check Bridge status =====
    let bridgeOnline = false
    try {
      const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json()
        bridgeOnline = data?.bridge?.authenticated === true
      }
    } catch {
      // Bridge unavailable — ok
    }

    // ===== Build local tools list =====
    const localTools = LOCAL_TOOLS.map(t => ({
      name: t.name,
      category: t.category,
      description: t.description,
      source: 'local' as const,
      accessMode: 'local' as const,
      dangerous: t.dangerous,
      implemented: t.implemented,
      apiKeyEnv: t.apiKeyEnv,
      hasApiKey: t.hasApiKey,
      enabled: true, // Local tools are always enabled
    }))

    // ===== Build gateway tools list =====
    const gatewayTools = GATEWAY_TOOL_REGISTRY.map(t => {
      const isSessionContext = SESSION_CONTEXT_TOOLS.has(t.name)
      const isHttpAccessible = HTTP_ACCESSIBLE_TOOLS.has(t.name)
      const accessMode = isSessionContext
        ? (bridgeOnline ? 'bridge' : 'unavailable')
        : 'http'

      return {
        name: t.name,
        category: t.category,
        description: t.description,
        source: 'gateway' as const,
        accessMode,
        sessionContext: isSessionContext,
        dangerous: isSessionContext && ['exec', 'write', 'edit', 'apply_patch', 'code_execution', 'process'].includes(t.name),
        implemented: true,
        apiKeyEnv: '',
        hasApiKey: true,
        enabled: true, // Gateway tools are always enabled
      }
    })

    // ===== Build custom tools list =====
    // Get from in-memory registry for fast access
    const customToolEntries = getAllCustomTools()

    // Also query DB for any tools not yet in memory (e.g., disabled ones).
    // FIX: the CustomTool Prisma model is not in schema.prisma — db.customTool
    // is undefined. Wrapped in try/catch so the route degrades gracefully
    // (returns the in-memory registry's custom tools + local + gateway tools
    // instead of 500-ing the whole endpoint). When the model is added later,
    // this branch will just start working.
    let dbCustomTools: Array<{ name: string }> = []
    try {
      if ((db as any).customTool) {
        dbCustomTools = await (db as any).customTool.findMany()
      }
    } catch (err) {
      console.warn('[Tools] customTool DB query skipped (model not in schema):', err instanceof Error ? err.message : String(err))
    }
    const dbToolMap = new Map(dbCustomTools.map(t => [t.name, t]))

    // Merge: prefer in-memory entries, add DB-only entries
    const allCustomNames = new Set([
      ...customToolEntries.map(t => t.name),
      ...dbCustomTools.map(t => t.name),
    ])

    const customTools: Array<{
      name: string
      category: string
      description: string
      source: string
      accessMode: string
      dangerous: boolean
      implemented: boolean
      enabled: boolean
      isPublic: boolean
      version: string
      skillSlug: string | null
      callCount: number
      handlerCode?: string
    }> = []

    for (const toolName of allCustomNames) {
      const memEntry = customToolEntries.find(t => t.name === toolName)
      const dbEntry = dbToolMap.get(toolName)

      if (memEntry) {
        customTools.push({
          name: memEntry.name,
          category: memEntry.category,
          description: memEntry.description,
          source: 'custom',
          accessMode: 'custom',
          dangerous: false,
          implemented: true,
          enabled: memEntry.enabled,
          isPublic: memEntry.isPublic,
          version: memEntry.version,
          skillSlug: memEntry.skillSlug,
          callCount: memEntry.callCount,
          handlerCode: memEntry.handlerCode,
        })
      } else if (dbEntry) {
        // Tool is in DB but not in memory (e.g., disabled)
        let parameters: Record<string, unknown>
        try {
          parameters = JSON.parse(dbEntry.parameters)
        } catch {
          parameters = { type: 'object', properties: {} }
        }
        customTools.push({
          name: dbEntry.name,
          category: dbEntry.category,
          description: dbEntry.description,
          source: 'custom',
          accessMode: 'custom',
          dangerous: false,
          implemented: true,
          enabled: dbEntry.enabled,
          isPublic: dbEntry.isPublic,
          version: dbEntry.version,
          skillSlug: dbEntry.skillSlug,
          callCount: dbEntry.callCount,
          handlerCode: dbEntry.handlerCode,
        })
        // Suppress unused variable warning
        void parameters
      }
    }

    // ===== Merge all tools, avoiding duplicates =====
    const localAndGatewayNames = new Set([
      ...localTools.map(t => t.name),
      ...gatewayTools.map(t => t.name),
    ])

    // Custom tools should not duplicate local/gateway tools
    const uniqueCustomTools = customTools.filter(t => !localAndGatewayNames.has(t.name))

    let allTools: Array<Record<string, unknown>> = [
      ...localTools,
      ...gatewayTools.filter(t => !localTools.some(l => l.name === t.name)),
      ...uniqueCustomTools,
    ]

    // ===== Apply filters =====

    // Filter by source
    if (sourceFilter !== 'all') {
      allTools = allTools.filter(t => t.source === sourceFilter)
    }

    // Filter by enabled (only meaningful for custom tools)
    if (enabledFilter !== null && enabledFilter !== undefined) {
      const isEnabled = enabledFilter === 'true'
      allTools = allTools.filter(t => {
        // Local and gateway tools are always enabled
        if (t.source !== 'custom') return isEnabled === true
        return t.enabled === isEnabled
      })
    }

    // Filter by category
    if (categoryFilter) {
      allTools = allTools.filter(t =>
        (t.category as string).toLowerCase() === categoryFilter.toLowerCase()
      )
    }

    // ===== Get permissions =====
    const permissions = await db.toolPermission.findMany({
      where: { agentId: 'default' },
    })
    const permMap = new Map(permissions.map(p => [p.toolName, p.permission]))

    // Merge with permissions
    const toolsWithPermissions = allTools.map(t => ({
      ...t,
      permission: permMap.get(t.name as string) || ((t.dangerous as boolean) ? 'ask' : 'allow'),
    }))

    // ===== Stats =====
    const local = allTools.filter(t => t.source === 'local').length
    const gatewayHttp = allTools.filter(t => t.accessMode === 'http').length
    const gatewayBridge = allTools.filter(t => t.accessMode === 'bridge').length
    const custom = allTools.filter(t => t.source === 'custom').length
    const unavailable = allTools.filter(t => t.accessMode === 'unavailable').length
    const categories = [...new Set(allTools.map(t => t.category as string))]

    return NextResponse.json({
      tools: toolsWithPermissions,
      total: toolsWithPermissions.length,
      bridge: {
        online: bridgeOnline,
      },
      stats: {
        local,
        gatewayHttp,
        gatewayBridge,
        custom,
        unavailable,
        total: allTools.length,
        accessibleTotal: local + gatewayHttp + gatewayBridge + custom,
      },
      categories,
    })
  } catch (err) {
    console.error('[Tools:List] Error:', err)
    return NextResponse.json(
      { error: 'Failed to list tools', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
