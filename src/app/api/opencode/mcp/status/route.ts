import { NextResponse } from 'next/server'
import { getMCPBridgeStatus } from '@/lib/opencode'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/mcp/status
 * Get MCP Bridge status — tool sharing between OpenClaw and OpenCode
 */
export async function GET() {
  // Try OpenCode server first
  try {
    const status = await getMCPBridgeStatus()
    if (status) {
      // Enrich with SQLite config
      const configs = await db.mCPBridgeConfig.findMany()
      // NOTE (type-only): map gốc tạo ra MẢNG CHUỖI key (không phải cặp
      // [key, value]) — giữ nguyên logic gốc, chỉ nới kiểu entry để tsc
      // chấp nhận cách dùng configMap.get() bên dưới.
      const configEntries = configs.map(c => `${c.direction}:${c.toolName}`) as unknown as Array<
        [string, (typeof configs)[number]]
      >
      const configMap = new Map(configEntries)

      // Apply enabled status from DB
      for (const tool of [...status.outbound.tools, ...status.inbound.tools]) {
        const key = `${tool.source === 'openclaw' ? 'outbound' : 'inbound'}:${tool.name}`
        const config = configMap.get(key)
        if (config) {
          tool.enabled = config.enabled
        }
      }

      return NextResponse.json({ ...status, source: 'opencode-server' })
    }
  } catch {
    // Server offline, fallback
  }

  // Fallback: static MCP config + DB overrides
  let configs = await db.mCPBridgeConfig.findMany()

  // Auto-seed default MCP bridge config entries if empty
  if (configs.length === 0) {
    const defaults = [
      { direction: 'outbound', toolName: 'knowledge_search', enabled: true, config: '{}' },
      { direction: 'outbound', toolName: 'knowledge_graph', enabled: true, config: '{}' },
      { direction: 'outbound', toolName: 'knowledge_write', enabled: true, config: '{}' },
      { direction: 'outbound', toolName: 'web_search', enabled: true, config: '{}' },
      { direction: 'inbound', toolName: 'file_read', enabled: true, config: '{}' },
      { direction: 'inbound', toolName: 'file_edit', enabled: true, config: '{}' },
      { direction: 'inbound', toolName: 'bash_exec', enabled: true, config: '{}' },
      { direction: 'inbound', toolName: 'lsp_diag', enabled: true, config: '{}' },
      { direction: 'inbound', toolName: 'fetch_url', enabled: true, config: '{}' },
    ]
    for (const d of defaults) {
      try {
        await db.mCPBridgeConfig.upsert({
          where: { direction_toolName: { direction: d.direction, toolName: d.toolName } },
          update: {},
          create: d,
        })
      } catch { /* ignore duplicate */ }
    }
    configs = await db.mCPBridgeConfig.findMany()
  }

  const outboundTools = [
    { name: 'knowledge_search', enabled: true, source: 'openclaw' },
    { name: 'knowledge_graph', enabled: true, source: 'openclaw' },
    { name: 'knowledge_write', enabled: true, source: 'openclaw' },
    { name: 'web_search', enabled: true, source: 'openclaw' },
  ]

  const inboundTools = [
    { name: 'file_read', enabled: true, source: 'opencode' },
    { name: 'file_edit', enabled: true, source: 'opencode' },
    { name: 'bash_exec', enabled: true, source: 'opencode' },
    { name: 'lsp_diag', enabled: true, source: 'opencode' },
    { name: 'fetch_url', enabled: true, source: 'opencode' },
  ]

  // Apply DB overrides
  for (const config of configs) {
    const tools = config.direction === 'outbound' ? outboundTools : inboundTools
    const tool = tools.find(t => t.name === config.toolName)
    if (tool) {
      tool.enabled = config.enabled
    }
  }

  return NextResponse.json({
    outbound: {
      description: 'OpenClaw Tools exposed as MCP servers for OpenCode',
      tools: outboundTools,
    },
    inbound: {
      description: 'OpenCode Tools registered as OpenClaw Skills',
      tools: inboundTools,
    },
    bridgeStatus: 'degraded',
    lastSync: new Date().toISOString(),
    source: 'local-fallback',
  })
}
