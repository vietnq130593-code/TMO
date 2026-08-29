/**
 * OpenClaw Tools API — Real Tool Catalog
 *
 * GET /api/openclaw/tools — List all real tools with permissions
 *
 * Each tool has:
 *   - implemented: always true (only real tools, no placeholders)
 *   - hasSkillGuide: true = có SKILL.md hướng dẫn trong DB
 *   - apiKeyEnv: env var cần thiết (nếu có)
 *   - hasApiKey: API key đã được cấu hình chưa
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { tavilyKeyPool, jinaKeyPool, serperKeyPool } from '@/lib/service-key-pool'

export const dynamic = 'force-dynamic'

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'

// ===== REAL TOOL DEFINITIONS =====
// Only tools with actual implementations in tool-executor.ts or SDK
// Virtual/placeholder tools have been removed

const LOCAL_TOOLS = [
  {
    name: 'opencode',
    category: 'Code',
    description: 'Đọc/viết file, chạy terminal command. Dùng bởi Code Team G2-A (BOLT) để implement code.',
    source: 'bundled',
    dangerous: true,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'knowledge_search',
    category: 'Data',
    description: 'Tìm kiếm semantic trong Knowledge Base (Qdrant + Neo4j). Mọi agent đều dùng được.',
    source: 'bundled',
    dangerous: false,
    implemented: true,
    hasSkillGuide: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'knowledge_graph',
    category: 'Data',
    description: 'Truy vấn đồ thị Neo4j bằng Cypher (chỉ read-only MATCH). Mọi agent đều dùng được.',
    source: 'bundled',
    dangerous: false,
    implemented: true,
    hasSkillGuide: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'knowledge_write',
    category: 'Data',
    description: 'Ghi entity/relationship mới vào Knowledge Base. Chỉ dùng khi cần thiết (dangerous).',
    source: 'bundled',
    dangerous: true,
    implemented: true,
    hasSkillGuide: true,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'tavily',
    category: 'Web',
    description: 'Deep web search AI-optimized. Trả về kết quả có nội dung tóm tắt + answer. 4 keys luân phiên. Fallback: z-ai-sdk.',
    source: 'api',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: 'TAVILY_API_KEY_1..4',
    hasApiKey: tavilyKeyPool.hasKeys(),
    totalKeys: tavilyKeyPool.getTotalCount(),
    availableKeys: tavilyKeyPool.getAvailableCount(),
  },
  {
    name: 'serper',
    category: 'Web',
    description: 'Google Search API. Trả về organic results với titles, snippets, links. 4 keys luân phiên. Fallback: z-ai-sdk.',
    source: 'api',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: 'SERPER_API_KEY_1..4',
    hasApiKey: serperKeyPool.hasKeys(),
    totalKeys: serperKeyPool.getTotalCount(),
    availableKeys: serperKeyPool.getAvailableCount(),
  },
  {
    name: 'jina',
    category: 'Web',
    description: 'Web page reader — đọc nội dung trang web từ URL. 2 keys luân phiên. Fallback: z-ai-sdk page_reader.',
    source: 'api',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: 'JINA_API_KEY_1..2',
    hasApiKey: jinaKeyPool.hasKeys(),
    totalKeys: jinaKeyPool.getTotalCount(),
    availableKeys: jinaKeyPool.getAvailableCount(),
  },
  {
    name: 'web_search',
    category: 'Web',
    description: 'Web search via z-ai-web-dev-sdk. Fallback cho Tavily/Serper khi API keys lỗi.',
    source: 'sdk',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '(none)',
    hasApiKey: true,
  },
  {
    name: 'page_reader',
    category: 'Web',
    description: 'Web page reader via z-ai-web-dev-sdk. Fallback cho Jina khi API key lỗi.',
    source: 'sdk',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '(none)',
    hasApiKey: true,
  },
  {
    name: 'file_write',
    category: 'File',
    description: 'Tạo file mới / ghi đè / nối tiếp (append) — tool chính thống cho FILE LỚN (viết từng phần ~200-400 dòng/lần với mode append, không truncate).',
    source: 'bundled',
    dangerous: true,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'start_preview',
    category: 'Preview',
    description: 'Start dev server cho active workspace (auto-detect framework, free port 3005+, log SSE). UI tự mở Preview panel khi tool chạy.',
    source: 'bundled',
    dangerous: true,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'stop_preview',
    category: 'Preview',
    description: 'Stop dev server đang chạy cho 1 workspace root (idempotent).',
    source: 'bundled',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'get_app_runtime_status',
    category: 'Preview',
    description: 'Kiểm tra trạng thái runtime: preview nào đang chạy (port, pid, user/agent khởi động), HTTP có respond không, tail log gần nhất. Read-only.',
    source: 'bundled',
    dangerous: false,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '',
    hasApiKey: true,
  },
  {
    name: 'manage_tools',
    category: 'Admin',
    description: '21-c Omega Tools Manager — quản lý tool-access của agents (CHỈ Omega): list_tools / set_tool_access / read_tool / read_skill / write_skill. Enforce ToolAssignment 2 lớp (prompt + executor).',
    source: 'bundled',
    dangerous: true,
    implemented: true,
    hasSkillGuide: false,
    apiKeyEnv: '',
    hasApiKey: true,
  },
]

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const source = searchParams.get('source') || 'all'

  let gatewayTools: Array<Record<string, unknown>> = []

  // Try gateway for additional tools
  if (source === 'all' || source === 'gateway') {
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/tools`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.tools && Array.isArray(data.tools)) {
          gatewayTools = data.tools
        }
      }
    } catch {
      // Gateway unavailable
    }
  }

  // Merge local tools with gateway tools (local takes priority)
  const localToolNames = new Set(LOCAL_TOOLS.map(t => t.name))
  const extraGatewayTools = gatewayTools.filter((t: Record<string, unknown>) => !localToolNames.has(t.name as string))

  const allTools = [
    ...LOCAL_TOOLS,
    ...extraGatewayTools.map((t: Record<string, unknown>) => ({
      name: (t.name || t.id) as string, // key lookup về sau cần string — data gateway là JSON không định dạng
      category: t.category || 'Other',
      description: t.description || '',
      source: 'gateway',
      dangerous: t.dangerous || false,
      implemented: false,
      hasSkillGuide: false,
      apiKeyEnv: '',
      hasApiKey: false,
    })),
  ]

  // Get current permissions
  const permissions = await db.toolPermission.findMany({
    where: { agentId: 'default' },
  })
  const permMap = new Map(permissions.map(p => [p.toolName, p.permission]))

  // Merge tools with their permissions
  const toolsWithPermissions = allTools.map(t => ({
    ...t,
    permission: permMap.get(t.name) || (t.dangerous ? 'ask' : 'allow'),
  }))

  // Stats
  const implemented = allTools.filter(t => t.implemented).length
  const placeholders = allTools.filter(t => !t.implemented).length
  const categories = [...new Set(allTools.map(t => t.category))]

  return NextResponse.json({
    tools: toolsWithPermissions,
    total: toolsWithPermissions.length,
    stats: { implemented, placeholders, total: allTools.length },
    categories,
  })
}
