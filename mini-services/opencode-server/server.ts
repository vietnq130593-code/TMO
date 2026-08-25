/**
 * OpenCode Hono Server — Magnum Opus
 * 
 * Provides OpenCode-compatible API endpoints:
 * - Health check & server info
 * - File tree browsing & file reading
 * - Bash command execution
 * - LSP diagnostics (TypeScript)
 * - Session management
 * - MCP bridge status
 * 
 * Port: 18790
 * Framework: Hono (Bun runtime)
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { readdir, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative, extname, resolve } from 'path'
import { execSync } from 'child_process'

// ============================================
// CONFIG
// ============================================
const PORT = parseInt(process.env.OPENCODE_SERVER_PORT || '18790')
// Resolve workspace: if relative (e.g. '.'), resolve from project root (3 levels up from this file)
const _rawWorkspace = process.env.OPENCODE_WORKSPACE || '.'
const WORKSPACE = _rawWorkspace.startsWith('/') ? _rawWorkspace : resolve(__dirname, '..', '..', _rawWorkspace)
const SERVER_VERSION = '1.0.0-magnum-opus'
const START_TIME = Date.now()

// ============================================
// TYPES
// ============================================
interface SessionInfo {
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

// ============================================
// STATE
// ============================================
const sessions: Map<string, SessionInfo> = new Map()
const terminalOutput: Map<string, string[]> = new Map()
let lspAvailable = false

try {
  execSync('which npx', { encoding: 'utf-8', timeout: 5000 })
  lspAvailable = true
} catch {
  lspAvailable = false
}

// ============================================
// HONO APP
// ============================================
const app = new Hono()

// ============================================
// Phase 1: CORS bind specific origin + token auth + OPTIONS preflight
// (replaces cors({origin:'*'}) — C3 fix)
// ============================================
const ALLOWED_ORIGINS = (process.env.OPENCODE_CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean)

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
    c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-TMO-API-Token')
    c.header('Access-Control-Max-Age', '86400')
  }
  if (c.req.method === 'OPTIONS') return c.body('', 204)
  // Phase 1: mọi request phải có X-TMO-API-Token (C1 fix)
  const token = c.req.header('X-TMO-API-Token')
  const expected = process.env.TMO_API_TOKEN
  if (!expected) return c.json({ error: 'TMO_API_TOKEN not configured' }, 503)
  if (token !== expected) return c.json({ error: 'Unauthorized' }, 401)
  return next()
})

// HEALTH CHECK
app.get('/health', (c) => {
  return c.json({ ok: true, status: 'live', timestamp: new Date().toISOString() })
})

// SERVER INFO
app.get('/info', (c) => {
  const uptime = Date.now() - START_TIME
  const hours = Math.floor(uptime / 3600000)
  const minutes = Math.floor((uptime % 3600000) / 60000)
  return c.json({
    version: SERVER_VERSION,
    port: PORT,
    workspace: WORKSPACE,
    uptime: `${hours}h ${minutes}m`,
    uptimeMs: uptime,
    sessions: {
      total: sessions.size,
      active: Array.from(sessions.values()).filter(s => s.status === 'active').length,
      completed: Array.from(sessions.values()).filter(s => s.status === 'completed').length,
    },
    tools: {
      available: ['file_read', 'file_edit', 'bash_exec', 'lsp_diag', 'fetch_url'],
      count: 5,
    },
    lsp: { available: lspAvailable, languages: lspAvailable ? ['typescript'] : [] },
    mcp: { servers: ['knowledge-bridge'], connected: 1 },
  })
})

// SESSIONS
app.get('/sessions', (c) => {
  const sessionList = Array.from(sessions.values())
  return c.json({ sessions: sessionList, total: sessionList.length })
})

app.post('/sessions', async (c) => {
  const body = await c.req.json()
  const { prompt, model, provider } = body
  if (!prompt) return c.json({ error: 'prompt is required' }, 400)

  const id = `oc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
  const session: SessionInfo = {
    id, sessionId: id,
    model: model || null, provider: provider || null,
    prompt, status: 'active',
    filesTouched: [], toolsUsed: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  sessions.set(id, session)
  terminalOutput.set(id, [`[${new Date().toISOString()}] Session created: "${prompt.substring(0, 100)}..."`])
  return c.json({ session, message: 'Session created successfully' }, 201)
})

app.post('/sessions/:id/pause', (c) => {
  const session = sessions.get(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  session.status = 'paused'
  session.updatedAt = new Date().toISOString()
  return c.json({ session, message: 'Session paused' })
})

app.post('/sessions/:id/resume', (c) => {
  const session = sessions.get(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  session.status = 'active'
  session.updatedAt = new Date().toISOString()
  return c.json({ session, message: 'Session resumed' })
})

app.delete('/sessions/:id', (c) => {
  const id = c.req.param('id')
  const session = sessions.get(id)
  if (!session) return c.json({ error: 'Session not found' }, 404)
  session.status = 'completed'
  session.updatedAt = new Date().toISOString()
  sessions.delete(id)
  terminalOutput.delete(id)
  return c.json({ message: 'Session deleted' })
})

// FILE TREE
app.get('/files/tree', async (c) => {
  const requestedPath = c.req.query('path') || ''
  const maxDepth = parseInt(c.req.query('depth') || '3')
  const rootPath = join(WORKSPACE, requestedPath)

  if (!existsSync(rootPath)) {
    return c.json({ error: 'Path not found', path: requestedPath }, 404)
  }

  const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache', 'qdrant-storage', '.openclaw-workspace', '.prisma', '.vercel'])
  const SKIP_EXTS = new Set(['.map', '.lock', '.db', '.db-journal', '.png', '.jpg', '.jpeg', '.gif', '.ico'])

  async function buildTree(dirPath: string, depth: number): Promise<any[]> {
    if (depth <= 0) return []
    try {
      const entries = await readdir(dirPath, { withFileTypes: true })
      const nodes: any[] = []
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })
      for (const entry of sorted) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        const fullPath = join(dirPath, entry.name)
        const relPath = relative(WORKSPACE, fullPath)
        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name, path: relPath, type: 'directory',
            children: depth > 1 ? await buildTree(fullPath, depth - 1) : undefined,
          })
        } else if (entry.isFile()) {
          if (SKIP_EXTS.has(extname(entry.name))) continue
          try {
            const stats = await stat(fullPath)
            nodes.push({ name: entry.name, path: relPath, type: 'file', size: stats.size, extension: extname(entry.name) || undefined })
          } catch { /* skip */ }
        }
      }
      return nodes
    } catch { return [] }
  }

  return c.json({ tree: await buildTree(rootPath, maxDepth), rootPath: requestedPath, workspace: WORKSPACE })
})

// FILE READ
app.get('/files/read', async (c) => {
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path is required' }, 400)
  const fullPath = join(WORKSPACE, filePath)
  if (!fullPath.startsWith(WORKSPACE)) return c.json({ error: 'Access denied' }, 403)
  if (!existsSync(fullPath)) return c.json({ error: 'File not found' }, 404)

  try {
    const stats = await stat(fullPath)
    if (stats.isDirectory()) return c.json({ error: 'Is directory' }, 400)
    if (stats.size > 500 * 1024) return c.json({ error: 'File too large' }, 413)
    const content = await readFile(fullPath, 'utf-8')
    const lines = content.split('\n').length
    const ext = extname(fullPath)
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
      '.json': 'json', '.css': 'css', '.html': 'html', '.md': 'markdown',
      '.prisma': 'prisma', '.yaml': 'yaml', '.yml': 'yaml',
    }
    return c.json({ path: filePath, content, language: langMap[ext] || 'plaintext', lines, size: stats.size, extension: ext })
  } catch (err: any) {
    return c.json({ error: 'Read failed', details: err.message }, 500)
  }
})

// BASH EXECUTE
app.post('/execute', async (c) => {
  const body = await c.req.json()
  const { command, sessionId } = body
  if (!command) return c.json({ error: 'command is required' }, 400)

  // Phase 1: expanded dangerous-pattern blocklist — exact-token + wildcard match (C4 fix)
  const DANGEROUS_PATTERNS = [
    'rm -rf /', 'rm -rf ~', 'rm -rf /home', 'rm -rf /usr', 'rm -rf /var',
    'rm -rf /opt', 'rm -rf /etc', 'rm -rf /boot', 'rm -rf /sys', 'rm -rf /proc',
    'mkfs', 'dd if=', 'dd of=/dev/',
    ':(){:|:&};:', ':(){ :|:& };:',
    'chmod 777', 'chmod -R 777',
    'find / -delete', 'find / -exec',
    '>/dev/sda',
    'shutdown', 'reboot', 'halt', 'init 0', 'init 6',
  ]
  const DANGEROUS_WILDCARD = ['curl *| *sh', 'wget *| *sh', 'curl *| *bash', 'wget *| *bash', 'curl * | sh', 'wget * | sh']
  const fullCmdLower = command.toLowerCase()
  const tokens = command.split(/\s+/).map(t => t.toLowerCase())
  for (const p of DANGEROUS_PATTERNS) {
    if (tokens.includes(p) || fullCmdLower.includes(p)) return c.json({ error: `Blocked dangerous pattern: ${p}` }, 403)
  }
  for (const w of DANGEROUS_WILDCARD) {
    const regex = new RegExp('^' + w.replace(/\*/g, '.*').replace(/\|/g, '\\|') + '$')
    if (regex.test(fullCmdLower)) return c.json({ error: `Blocked dangerous pattern: ${w}` }, 403)
  }

  try {
    const result = execSync(command, { cwd: WORKSPACE, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    if (sessionId && terminalOutput.has(sessionId)) {
      const output = terminalOutput.get(sessionId)!
      output.push(`$ ${command}`)
      output.push(result.substring(0, 5000))
    }
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!
      if (!session.toolsUsed.includes('bash_exec')) session.toolsUsed.push('bash_exec')
      session.updatedAt = new Date().toISOString()
    }
    return c.json({ success: true, output: result, command, exitCode: 0 })
  } catch (err: any) {
    return c.json({ success: false, output: err.stdout || '', error: err.stderr || err.message, command, exitCode: err.status || 1 })
  }
})

// LSP DIAGNOSTICS
app.post('/lsp/diagnostics', async (c) => {
  const body = await c.req.json()
  const { filePath } = body
  if (!lspAvailable) return c.json({ diagnostics: [], available: false })
  try {
    let cmd = 'npx tsc --noEmit --pretty false 2>&1 | head -50'
    if (filePath) cmd = `npx tsc --noEmit --pretty false 2>&1 | grep "${filePath}" | head -20`
    const result = execSync(cmd, { cwd: WORKSPACE, timeout: 60000, encoding: 'utf-8' })
    const diagnostics = result.split('\n').filter(l => l.trim()).slice(0, 30).map(line => {
      const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/)
      return m ? { file: m[1], line: +m[2], column: +m[3], severity: m[4], code: m[5], message: m[6] } : { raw: line }
    })
    return c.json({ diagnostics, source: 'tsc', filePath: filePath || 'all' })
  } catch (err: any) {
    const output = err.stdout || ''
    if (output) {
      const diagnostics = output.split('\n').filter(l => l.trim()).slice(0, 30).map(line => {
        const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/)
        return m ? { file: m[1], line: +m[2], column: +m[3], severity: m[4], code: m[5], message: m[6] } : null
      }).filter(Boolean)
      return c.json({ diagnostics, source: 'tsc', filePath: filePath || 'all' })
    }
    return c.json({ diagnostics: [], error: err.message })
  }
})

// TERMINAL
app.get('/terminal', (c) => {
  const sessionId = c.req.query('sessionId')
  if (!sessionId) {
    const allOutput: Record<string, string[]> = {}
    for (const [id, output] of terminalOutput) allOutput[id] = output
    return c.json({ terminals: allOutput })
  }
  return c.json({ sessionId, output: terminalOutput.get(sessionId) || [], lines: (terminalOutput.get(sessionId) || []).length })
})

// TOOLS
app.get('/tools', (c) => {
  return c.json({
    tools: [
      { name: 'file_read', description: 'Read file content', category: 'file', source: 'builtin', dangerous: false },
      { name: 'file_edit', description: 'Edit file content', category: 'file', source: 'builtin', dangerous: true },
      { name: 'bash_exec', description: 'Execute bash commands', category: 'system', source: 'builtin', dangerous: true },
      { name: 'lsp_diag', description: 'LSP diagnostics', category: 'code', source: 'builtin', dangerous: false },
      { name: 'fetch_url', description: 'Fetch URL content', category: 'network', source: 'builtin', dangerous: false },
    ],
    total: 5,
  })
})

// MCP BRIDGE STATUS
app.get('/mcp/status', (c) => {
  return c.json({
    outbound: {
      description: 'OpenClaw Tools exposed as MCP servers for OpenCode',
      tools: [
        { name: 'knowledge_search', enabled: true, source: 'openclaw' },
        { name: 'knowledge_graph', enabled: true, source: 'openclaw' },
        { name: 'knowledge_write', enabled: true, source: 'openclaw' },
        { name: 'web_search', enabled: true, source: 'openclaw' },
      ],
    },
    inbound: {
      description: 'OpenCode Tools registered as OpenClaw Skills',
      tools: [
        { name: 'file_read', enabled: true, source: 'opencode' },
        { name: 'file_edit', enabled: true, source: 'opencode' },
        { name: 'bash_exec', enabled: true, source: 'opencode' },
        { name: 'lsp_diag', enabled: true, source: 'opencode' },
        { name: 'fetch_url', enabled: true, source: 'opencode' },
      ],
    },
    bridgeStatus: 'active',
    lastSync: new Date().toISOString(),
  })
})

// START
console.log(`[OpenCode Server] Starting on port ${PORT}`)
console.log(`[OpenCode Server] Workspace: ${WORKSPACE}`)
console.log(`[OpenCode Server] LSP: ${lspAvailable}`)
console.log(`[OpenCode Server] Version: ${SERVER_VERSION}`)

// Use Bun's native server — more stable than @hono/node-server with Bun
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
})

console.log(`[OpenCode Server] ✅ Running on http://127.0.0.1:${PORT}`)

// Keep process alive
setInterval(() => {}, 30000)
