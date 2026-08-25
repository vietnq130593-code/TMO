/**
 * OpenCode Client Library — Magnum Opus
 * 
 * Provides typed access to the OpenCode Server (port 18790).
 * All methods include timeout and error handling.
 * Used by API routes (server-side only).
 */

const OPENCODE_URL = process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:18790'

// ============================================
// BASE FETCH WITH TIMEOUT
// ============================================

export async function opencodeFetch(path: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000) // 15s default timeout
  // Phase 1: inject X-TMO-API-Token — opencode-server requires it for EVERY request.
  // Without this, service-manager health checks get 401 → restart loop.
  const headers = new Headers(options?.headers)
  if (!headers.has('X-TMO-API-Token') && process.env.TMO_API_TOKEN) {
    headers.set('X-TMO-API-Token', process.env.TMO_API_TOKEN)
  }
  try {
    const res = await fetch(`${OPENCODE_URL}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    })
    return res
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================
// HEALTH CHECK
// ============================================

export async function isOpenCodeOnline(): Promise<boolean> {
  try {
    const res = await opencodeFetch('/health')
    const data = await res.json()
    return data.ok === true
  } catch {
    return false
  }
}

// ============================================
// SERVER INFO
// ============================================

export interface OpenCodeServerInfo {
  version: string
  port: number
  workspace: string
  uptime: string
  uptimeMs: number
  sessions: {
    total: number
    active: number
    completed: number
  }
  tools: {
    available: string[]
    count: number
  }
  lsp: {
    available: boolean
    languages: string[]
  }
  mcp: {
    servers: string[]
    connected: number
  }
}

export async function getOpenCodeInfo(): Promise<OpenCodeServerInfo | null> {
  try {
    const res = await opencodeFetch('/info')
    return await res.json()
  } catch {
    return null
  }
}

// ============================================
// SESSIONS
// ============================================

export interface OpenCodeSession {
  id: string
  sessionId: string
  model: string | null
  provider: string | null
  prompt: string | null
  status: 'active' | 'paused' | 'completed' | 'failed'
  filesTouched: string[]
  toolsUsed: string[]
  createdAt: string
  updatedAt: string
}

export async function listOpenCodeSessions(): Promise<OpenCodeSession[]> {
  try {
    const res = await opencodeFetch('/sessions')
    const data = await res.json()
    return data.sessions || []
  } catch {
    return []
  }
}

export async function createOpenCodeSession(params: {
  prompt: string
  model?: string
  provider?: string
}): Promise<OpenCodeSession | null> {
  try {
    const res = await opencodeFetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json()
    return data.session || null
  } catch {
    return null
  }
}

export async function pauseOpenCodeSession(sessionId: string): Promise<boolean> {
  try {
    const res = await opencodeFetch(`/sessions/${sessionId}/pause`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

export async function resumeOpenCodeSession(sessionId: string): Promise<boolean> {
  try {
    const res = await opencodeFetch(`/sessions/${sessionId}/resume`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

export async function deleteOpenCodeSession(sessionId: string): Promise<boolean> {
  try {
    const res = await opencodeFetch(`/sessions/${sessionId}`, { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}

// ============================================
// FILE OPERATIONS
// ============================================

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
  children?: FileTreeNode[]
}

export async function getFileTree(path?: string, depth?: number): Promise<FileTreeNode[] | null> {
  try {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    if (depth) params.set('depth', String(depth))
    const res = await opencodeFetch(`/files/tree?${params.toString()}`)
    const data = await res.json()
    return data.tree || null
  } catch {
    return null
  }
}

export interface FileContent {
  path: string
  content: string
  language: string
  lines: number
  size: number
  extension: string
}

export async function readFileContent(path: string): Promise<FileContent | null> {
  try {
    const res = await opencodeFetch(`/files/read?path=${encodeURIComponent(path)}`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ============================================
// BASH EXECUTION
// ============================================

export interface BashResult {
  success: boolean
  output: string
  error?: string
  command: string
  exitCode: number
}

export async function executeBashCommand(params: {
  command: string
  sessionId?: string
}): Promise<BashResult | null> {
  try {
    const res = await opencodeFetch('/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    return await res.json()
  } catch {
    return null
  }
}

// ============================================
// LSP DIAGNOSTICS
// ============================================

export interface LSPDiagnostic {
  file?: string
  line?: number
  column?: number
  severity?: string
  code?: string
  message?: string
  raw?: string
}

export async function getLSPDiagnostics(filePath?: string): Promise<LSPDiagnostic[]> {
  try {
    const res = await opencodeFetch('/lsp/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    })
    const data = await res.json()
    return data.diagnostics || []
  } catch {
    return []
  }
}

// ============================================
// TOOLS LIST
// ============================================

export interface OpenCodeTool {
  name: string
  description: string
  category: string
  source: string
  dangerous: boolean
}

export async function listOpenCodeTools(): Promise<OpenCodeTool[]> {
  try {
    const res = await opencodeFetch('/tools')
    const data = await res.json()
    return data.tools || []
  } catch {
    return []
  }
}

// ============================================
// MCP BRIDGE STATUS
// ============================================

export interface MCPBridgeStatus {
  outbound: {
    description: string
    tools: { name: string; enabled: boolean; source: string }[]
  }
  inbound: {
    description: string
    tools: { name: string; enabled: boolean; source: string }[]
  }
  bridgeStatus: string
  lastSync: string
}

export async function getMCPBridgeStatus(): Promise<MCPBridgeStatus | null> {
  try {
    const res = await opencodeFetch('/mcp/status')
    return await res.json()
  } catch {
    return null
  }
}

// ============================================
// TERMINAL OUTPUT
// ============================================

export async function getTerminalOutput(sessionId?: string): Promise<{
  sessionId?: string
  output?: string[]
  terminals?: Record<string, string[]>
  lines?: number
} | null> {
  try {
    const params = sessionId ? `?sessionId=${sessionId}` : ''
    const res = await opencodeFetch(`/terminal${params}`)
    return await res.json()
  } catch {
    return null
  }
}
