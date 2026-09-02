/**
 * Gateway WebSocket Bridge Service
 *
 * Connects to the OpenClaw Gateway via WebSocket and exposes a REST API
 * that allows the Next.js app to route chat through the Gateway's agent session.
 *
 * This gives access to ALL 37 Gateway tools (including session-context tools
 * like exec, read, write, image_generate, etc.) that are NOT available via
 * the stateless /tools/invoke HTTP endpoint.
 *
 * Architecture:
 *   Next.js → REST API (this service, port 18791) → WebSocket → OpenClaw Gateway
 *   Gateway agent has access to all tools and executes them in session context
 *
 * Port: 18791
 * Gateway: ws://127.0.0.1:18789
 */

import { WebSocket } from 'ws'
import { execSync } from 'child_process'

// Bun global — tsconfig chính chưa include bun-types; khai báo interface
// tối thiểu cho đúng shape API đang dùng (runtime vẫn dùng global Bun thật).
declare const Bun: {
  serve(options: {
    port?: number | string
    hostname?: string
    fetch: (request: Request) => Response | Promise<Response>
  }): {
    port: number
    hostname: string
    fetch: (request: Request) => Response | Promise<Response>
  }
}

// ==================== ORPHAN CLEANUP ====================

/** Root-cause fix (2026-08-25 post-deploy audit): when the app restarts, an
 *  orphaned previous instance of this service can still hold port 18791 —
 *  the new instance then dies with EADDRINUSE and the service-manager gives
 *  up after 3 retries. Kill any orphaned port holders before binding. */
function killPortHolders(port: number): void {
  try {
    const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 3000 })
    const pids = out.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s))
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10)
      if (pid === process.pid) continue // never kill ourselves
      try {
        console.log(`[GatewayBridge] Killing orphaned port ${port} holder PID ${pid}...`)
        process.kill(pid, 'SIGKILL')
      } catch { /* already dead */ }
    }
    if (pids.length > 0) {
      const start = Date.now()
      while (Date.now() - start < 1000) { /* brief settle for socket release */ }
    }
  } catch { /* lsof unavailable — non-fatal */ }
}

// ==================== CONFIG ====================

// FIX 2026-09-15 (multi-instance): port từ env — bản clone đặt GATEWAY_BRIDGE_PORT riêng.
const PORT = parseInt(process.env.GATEWAY_BRIDGE_PORT || '18791', 10)

// Root-cause fix: reap any orphaned previous instance before binding.
killPortHolders(PORT)
const GATEWAY_WS_URL = process.env.OPENCLAW_GATEWAY_WS_URL || 'ws://127.0.0.1:18789'
const GATEWAY_HTTP_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'

// ==================== TYPES ====================

interface WSFrame {
  type: 'req' | 'res' | 'event'
  id?: string
  method?: string
  params?: Record<string, unknown>
  ok?: boolean
  payload?: Record<string, unknown>
  error?: { type: string; message: string; details?: unknown }
  event?: string
  /** Event sequence number — used to resume the event stream after reconnect */
  seq?: number
}

interface PendingRequest {
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  createdAt: number
}

interface ChatSession {
  id: string
  connected: boolean
  lastActivity: number
}

// ==================== GATEWAY WS CLIENT ====================

class GatewayWSClient {
  private ws: WebSocket | null = null
  private pendingRequests: Map<string, PendingRequest> = new Map()
  private requestId = 0
  private connected = false
  private authenticated = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectBaseDelayMs = 5000
  private reconnectMaxDelayMs = 120000
  private lastEventSeq = 0
  private sessionInfo: Record<string, unknown> = {}
  private eventHandlers: Map<string, Array<(payload: unknown) => void>> = new Map()
  private chatBuffers: Map<string, Array<{ role: string; content: string; toolCalls?: unknown[] }>> = new Map()
  private chatResolvers: Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }> = new Map()
  private protocol = 4
  private connId = ''
  private features: Record<string, unknown> = {}

  constructor(private url: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[GatewayBridge] Connecting to ${this.url}...`)

      this.ws = new WebSocket(this.url)

      const connectTimeout = setTimeout(() => {
        reject(new Error('Connection timeout'))
        this.ws?.close()
      }, 10000)

      // Handle challenge frame
      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const frame = JSON.parse(data.toString()) as WSFrame

          if (frame.type === 'event' && frame.event === 'connect.challenge') {
            console.log('[GatewayBridge] Received challenge, sending connect request...')
            this.sendConnectRequest(frame.payload as { nonce: string; ts: number })
            return
          }

          if (frame.type === 'res' && frame.id) {
            const pending = this.pendingRequests.get(frame.id)
            if (pending) {
              clearTimeout(pending.timeout)
              this.pendingRequests.delete(frame.id)
              if (frame.ok) {
                pending.resolve(frame.payload || {})
              } else {
                pending.reject(new Error(frame.error?.message || 'Gateway error'))
              }
              return
            }
          }

          // Handle chat events
          if (frame.type === 'event') {
            this.handleEvent(frame)
          }
        } catch (err) {
          console.error('[GatewayBridge] Error parsing frame:', err)
        }
      })

      this.ws.on('open', () => {
        console.log('[GatewayBridge] WebSocket connected')
        this.connected = true
        // Wait for challenge, don't resolve yet
      })

      this.ws.on('close', () => {
        console.log('[GatewayBridge] WebSocket disconnected')
        this.connected = false
        this.authenticated = false
        clearTimeout(connectTimeout)
        this.scheduleReconnect()
      })

      this.ws.on('error', (err: Error) => {
        console.error('[GatewayBridge] WebSocket error:', err.message)
        clearTimeout(connectTimeout)
        if (!this.authenticated) {
          reject(new Error(`Connection failed: ${err.message}`))
        }
      })

      // Wait for authentication
      const authCheck = setInterval(() => {
        if (this.authenticated) {
          clearInterval(authCheck)
          clearTimeout(connectTimeout)
          resolve()
        }
      }, 100)
    })
  }

  private sendConnectRequest(challenge: { nonce: string; ts: number }) {
    const reqId = this.nextId()
    // Use gateway-client/backend for trusted loopback connections
    // See: Gateway protocol docs - "client.id: gateway-client, client.mode: backend"
    const connectFrame: WSFrame = {
      type: 'req',
      id: reqId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 4,
        client: {
          id: 'gateway-client',
          version: '1.0.0',
          platform: 'server',
          mode: 'backend',
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals', 'operator.pairing'],
        caps: [],
        commands: [],
        permissions: {},
        auth: {}, // No auth needed for loopback + --auth none
        locale: 'en-US',
        userAgent: 'gateway-bridge/1.0.0',
      },
    }

    // Set up response handler for connect
    this.pendingRequests.set(reqId, {
      resolve: (payload: unknown) => {
        const p = payload as Record<string, unknown>
        console.log('[GatewayBridge] Authenticated! Protocol:', (p as Record<string, unknown>).protocol || 'unknown')
        this.authenticated = true
        this.sessionInfo = p
        if (typeof p === 'object' && p !== null) {
          this.protocol = (p as Record<string, unknown>).protocol as number || 4
          const server = (p as Record<string, unknown>).server as Record<string, unknown> | undefined
          if (server) this.connId = server.connId as string || ''
          this.features = (p as Record<string, unknown>).features as Record<string, unknown> || {}
        }
      },
      reject: (err: Error) => {
        console.error('[GatewayBridge] Authentication failed:', err.message)
      },
      timeout: setTimeout(() => {
        this.pendingRequests.delete(reqId)
        console.error('[GatewayBridge] Connect request timeout')
      }, 15000),
      createdAt: Date.now(),
    })

    this.sendFrame(connectFrame)
  }

  private handleEvent(frame: WSFrame) {
    const eventName = frame.event
    const payload = frame.payload

    if (frame.seq) {
      this.lastEventSeq = frame.seq
    }

    // Handle chat response events
    if (eventName === 'chat.response' || eventName === 'chat.delta' || eventName === 'chat.done') {
      this.handleChatEvent(eventName, payload)
    }

    // Dispatch to event handlers
    const handlers = this.eventHandlers.get(eventName || '')
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload)
        } catch (err) {
          console.error(`[GatewayBridge] Event handler error for ${eventName}:`, err)
        }
      }
    }
  }

  private handleChatEvent(eventName: string, payload: unknown) {
    // Chat events come back from the Gateway when we send a chat message
    // We need to collect the response and resolve the chat promise
    const p = payload as Record<string, unknown>
    const sessionId = p.sessionId as string || p.session_id as string || 'default'

    if (eventName === 'chat.done') {
      const resolver = this.chatResolvers.get(sessionId)
      if (resolver) {
        this.chatResolvers.delete(sessionId)
        resolver.resolve(p)
      }
    }
  }

  async sendChat(message: string, options?: {
    sessionKey?: string
    agentId?: string
    model?: string
  }): Promise<unknown> {
    if (!this.authenticated) {
      throw new Error('Not authenticated to Gateway')
    }

    // Gateway's chat.send requires sessionKey (default: "main") and idempotencyKey
    // The sessionKey must match the agent's session key (e.g., "main" for default agent)
    const result = await this.request('chat.send', {
      message,
      sessionKey: options?.sessionKey || 'main',
      idempotencyKey: `bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      ...(options?.model ? { model: options.model } : {}),
    })

    return result
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to Gateway')
    }

    const id = this.nextId()

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 60000) // 60s timeout for chat

      this.pendingRequests.set(id, { resolve, reject, timeout, createdAt: Date.now() })

      this.sendFrame({
        type: 'req',
        id,
        method,
        params,
      })
    })
  }

  private sendFrame(frame: WSFrame) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private nextId(): string {
    return `br_${Date.now()}_${++this.requestId}`
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return

    this.reconnectAttempts++
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`[GatewayBridge] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Will retry on next health check.`)
      this.reconnectAttempts = 0 // Reset to allow health check to retry
      return
    }

    const delay = Math.min(this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1), this.reconnectMaxDelayMs)
    
    // Reduce log noise: only log every 3rd attempt or on first attempt
    if (this.reconnectAttempts === 1 || this.reconnectAttempts % 3 === 0) {
      console.log(`[GatewayBridge] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`)
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
        console.log('[GatewayBridge] Reconnected successfully')
        this.reconnectAttempts = 0 // Reset on success
      } catch (err) {
        // Only log every 3rd failure to reduce noise
        if (this.reconnectAttempts % 3 === 0) {
          console.error('[GatewayBridge] Reconnect failed:', err instanceof Error ? err.message : String(err))
        }
        this.scheduleReconnect()
      }
    }, delay)
  }

  getStatus() {
    return {
      connected: this.connected,
      authenticated: this.authenticated,
      connId: this.connId,
      protocol: this.protocol,
      pendingRequests: this.pendingRequests.size,
      lastEventSeq: this.lastEventSeq,
    }
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.authenticated = false
  }
}

// ==================== ALL 37 GATEWAY TOOLS ====================

const ALL_GATEWAY_TOOLS = [
  // Web & Search
  { name: 'web_search', category: 'Web', description: 'Search the web via Gateway', httpAccessible: true },
  { name: 'web_fetch', category: 'Web', description: 'Fetch web page content via Gateway', httpAccessible: true },
  { name: 'x_search', category: 'Web', description: 'Search X/Twitter posts via Gateway', httpAccessible: false },

  // Memory
  { name: 'memory_search', category: 'Memory', description: 'Search agent memory via Gateway', httpAccessible: true },
  { name: 'memory_get', category: 'Memory', description: 'Read memory files via Gateway', httpAccessible: true },

  // Files & Code (session-context)
  { name: 'exec', category: 'Runtime', description: 'Execute shell commands (session context)', httpAccessible: false },
  { name: 'read', category: 'Files', description: 'Read files (session context)', httpAccessible: false },
  { name: 'write', category: 'Files', description: 'Write files (session context)', httpAccessible: false },
  { name: 'edit', category: 'Files', description: 'Edit files (session context)', httpAccessible: false },
  { name: 'apply_patch', category: 'Files', description: 'Apply patches to files (session context)', httpAccessible: false },
  { name: 'code_execution', category: 'Runtime', description: 'Execute Python code (session context)', httpAccessible: false },
  { name: 'process', category: 'Runtime', description: 'Manage processes (session context)', httpAccessible: false },

  // Browser & Canvas
  { name: 'browser', category: 'Browser', description: 'Control browser via Gateway', httpAccessible: true },
  { name: 'canvas', category: 'Canvas', description: 'Canvas visual workspace via Gateway', httpAccessible: true },

  // Sessions & Agents
  { name: 'sessions_list', category: 'Sessions', description: 'List Gateway sessions', httpAccessible: true },
  { name: 'sessions_history', category: 'Sessions', description: 'Get session history', httpAccessible: true },
  { name: 'session_status', category: 'Sessions', description: 'Get session status', httpAccessible: true },
  { name: 'sessions_yield', category: 'Sessions', description: 'Yield session control', httpAccessible: true },
  { name: 'sessions_spawn', category: 'Sessions', description: 'Spawn new session (session context)', httpAccessible: false },
  { name: 'sessions_send', category: 'Sessions', description: 'Send to another session (session context)', httpAccessible: false },
  { name: 'agents_list', category: 'Sessions', description: 'List Gateway agents', httpAccessible: true },
  { name: 'message', category: 'Messaging', description: 'Send message via Gateway', httpAccessible: true },

  // Automation
  { name: 'cron', category: 'Automation', description: 'Manage cron jobs (session context)', httpAccessible: false },
  { name: 'heartbeat_respond', category: 'Automation', description: 'Respond to heartbeat (session context)', httpAccessible: false },

  // System
  { name: 'gateway', category: 'System', description: 'Gateway management (session context)', httpAccessible: false },
  { name: 'nodes', category: 'System', description: 'Manage nodes (session context)', httpAccessible: false },
  { name: 'update_plan', category: 'System', description: 'Update plan (session context)', httpAccessible: false },

  // Media
  { name: 'tts', category: 'Media', description: 'Text-to-speech via Gateway', httpAccessible: true },
  { name: 'skill_workshop', category: 'Skills', description: 'Create/edit skills via Gateway', httpAccessible: true },
  { name: 'image', category: 'Media', description: 'Analyze images (session context)', httpAccessible: false },
  { name: 'image_generate', category: 'Media', description: 'Generate images via Gateway (session context)', httpAccessible: false },
  { name: 'music_generate', category: 'Media', description: 'Generate music via Gateway (session context)', httpAccessible: false },
  { name: 'video_generate', category: 'Media', description: 'Generate video via Gateway (session context)', httpAccessible: false },

  // Goals & Planning
  { name: 'create_goal', category: 'Planning', description: 'Create a goal/objective', httpAccessible: true },
  { name: 'get_goal', category: 'Planning', description: 'Get current goal', httpAccessible: true },
  { name: 'update_goal', category: 'Planning', description: 'Update goal status', httpAccessible: true },
]

// ==================== HTTP SERVER ====================

const gatewayClient = new GatewayWSClient(GATEWAY_WS_URL)

// Simple HTTP server using Bun's built-in
const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    try {
      // Health check
      if (path === '/health') {
        const gwHealth = await checkGatewayHealth()
        const bridgeStatus = gatewayClient.getStatus()
        return Response.json({
          ok: true,
          bridge: {
            status: bridgeStatus.authenticated ? 'connected' : bridgeStatus.connected ? 'connecting' : 'disconnected',
            ...bridgeStatus,
          },
          gateway: gwHealth,
          tools: {
            total: ALL_GATEWAY_TOOLS.length,
            httpAccessible: ALL_GATEWAY_TOOLS.filter(t => t.httpAccessible).length,
            sessionContext: ALL_GATEWAY_TOOLS.filter(t => !t.httpAccessible).length,
            bridgeAccessible: bridgeStatus.authenticated ? ALL_GATEWAY_TOOLS.length : ALL_GATEWAY_TOOLS.filter(t => t.httpAccessible).length,
          },
        }, { headers: corsHeaders })
      }

      // List all tools
      if (path === '/tools') {
        const bridgeStatus = gatewayClient.getStatus()
        return Response.json({
          tools: ALL_GATEWAY_TOOLS.map(t => ({
            ...t,
            accessible: t.httpAccessible || bridgeStatus.authenticated,
            accessMode: t.httpAccessible ? 'http' : (bridgeStatus.authenticated ? 'bridge' : 'unavailable'),
          })),
          total: ALL_GATEWAY_TOOLS.length,
          httpCount: ALL_GATEWAY_TOOLS.filter(t => t.httpAccessible).length,
          bridgeCount: bridgeStatus.authenticated ? ALL_GATEWAY_TOOLS.length : ALL_GATEWAY_TOOLS.filter(t => t.httpAccessible).length,
        }, { headers: corsHeaders })
      }

      // Invoke a tool directly (HTTP or via bridge)
      if (path === '/tools/invoke' && req.method === 'POST') {
        const body = await req.json() as { name: string; args: Record<string, unknown> }
        const { name, args } = body

        if (!name) {
          return Response.json({ ok: false, error: 'Tool name is required' }, { status: 400, headers: corsHeaders })
        }

        const toolDef = ALL_GATEWAY_TOOLS.find(t => t.name === name)
        if (!toolDef) {
          return Response.json({ ok: false, error: `Unknown tool: ${name}` }, { status: 404, headers: corsHeaders })
        }

        // Try HTTP first for HTTP-accessible tools
        if (toolDef.httpAccessible) {
          try {
            const result = await invokeGatewayHTTP(name, args)
            return Response.json({ ok: true, result, mode: 'http' }, { headers: corsHeaders })
          } catch (err) {
            // Fall through to bridge if available
            if (!gatewayClient.getStatus().authenticated) {
              return Response.json({
                ok: false,
                error: `HTTP invocation failed and bridge not available: ${err instanceof Error ? err.message : String(err)}`,
              }, { status: 500, headers: corsHeaders })
            }
          }
        }

        // Use bridge for session-context tools
        if (gatewayClient.getStatus().authenticated) {
          try {
            // Route through Gateway's agent session
            const result = await routeToolViaBridge(name, args)
            return Response.json({ ok: true, result, mode: 'bridge' }, { headers: corsHeaders })
          } catch (err) {
            return Response.json({
              ok: false,
              error: `Bridge invocation failed: ${err instanceof Error ? err.message : String(err)}`,
            }, { status: 500, headers: corsHeaders })
          }
        }

        return Response.json({
          ok: false,
          error: `Tool "${name}" requires session context. Gateway bridge is not connected. Start the Gateway bridge first.`,
        }, { status: 503, headers: corsHeaders })
      }

      // Chat through Gateway agent (access to all 37 tools)
      if (path === '/chat' && req.method === 'POST') {
        const body = await req.json() as {
          message: string
          sessionKey?: string
          agentId?: string
          model?: string
        }
        const { message, sessionKey, agentId, model } = body

        if (!message) {
          return Response.json({ ok: false, error: 'Message is required' }, { status: 400, headers: corsHeaders })
        }

        if (!gatewayClient.getStatus().authenticated) {
          // Fallback to HTTP /v1/chat/completions or direct tool invocation
          return Response.json({
            ok: false,
            error: 'Gateway bridge not connected. Cannot route chat through Gateway agent session.',
          }, { status: 503, headers: corsHeaders })
        }

        try {
          const result = await gatewayClient.sendChat(message, {
            sessionKey,
            agentId,
            model,
          })
          return Response.json({ ok: true, result }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({
            ok: false,
            error: `Chat failed: ${err instanceof Error ? err.message : String(err)}`,
          }, { status: 500, headers: corsHeaders })
        }
      }

      // Bridge status
      if (path === '/status') {
        const bridgeStatus = gatewayClient.getStatus()
        return Response.json({
          bridge: bridgeStatus,
          gatewayUrl: GATEWAY_WS_URL,
          toolsAccessible: bridgeStatus.authenticated ? ALL_GATEWAY_TOOLS.length : ALL_GATEWAY_TOOLS.filter(t => t.httpAccessible).length,
        }, { headers: corsHeaders })
      }

      // Reconnect
      if (path === '/reconnect' && req.method === 'POST') {
        try {
          await gatewayClient.disconnect()
          await gatewayClient.connect()
          return Response.json({ ok: true, status: gatewayClient.getStatus() }, { headers: corsHeaders })
        } catch (err) {
          return Response.json({
            ok: false,
            error: `Reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
          }, { status: 500, headers: corsHeaders })
        }
      }

      return Response.json({ error: 'Not Found' }, { status: 404, headers: corsHeaders })

    } catch (err) {
      console.error('[GatewayBridge] Request error:', err)
      return Response.json({
        ok: false,
        error: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
      }, { status: 500, headers: corsHeaders })
    }
  },
})

// ==================== HELPER FUNCTIONS ====================

async function checkGatewayHealth(): Promise<{ online: boolean; responseTime?: number }> {
  const start = Date.now()
  try {
    const res = await fetch(`${GATEWAY_HTTP_URL}/health`, { signal: AbortSignal.timeout(5000) })
    const data = await res.json() as { ok: boolean }
    return { online: data.ok === true, responseTime: Date.now() - start }
  } catch {
    return { online: false }
  }
}

async function invokeGatewayHTTP(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${GATEWAY_HTTP_URL}/tools/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error')
    throw new Error(`Gateway HTTP tool error ${res.status}: ${errorText.slice(0, 200)}`)
  }

  const data = await res.json() as { ok: boolean; result?: unknown; error?: { message: string } }
  if (!data.ok && data.error) {
    throw new Error(`Tool error: ${data.error.message}`)
  }

  return data.result ?? data
}

async function routeToolViaBridge(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Format a message that tells the Gateway's agent to use a specific tool
  // The agent will then decide whether to use it and execute within session context
  const toolMessage = `Use the ${name} tool with these arguments: ${JSON.stringify(args, null, 2)}. Execute this tool and return the result.`

  const result = await gatewayClient.sendChat(toolMessage)
  return result
}

// ==================== STARTUP ====================

async function main() {
  console.log(`[GatewayBridge] Starting on port ${PORT}`)
  console.log(`[GatewayBridge] Gateway WS: ${GATEWAY_WS_URL}`)
  console.log(`[GatewayBridge] Gateway HTTP: ${GATEWAY_HTTP_URL}`)

  // Try to connect to Gateway
  try {
    await gatewayClient.connect()
    console.log('[GatewayBridge] ✅ Connected and authenticated to Gateway')
    console.log(`[GatewayBridge] All ${ALL_GATEWAY_TOOLS.length} tools now accessible`)
  } catch (err) {
    console.warn(`[GatewayBridge] ⚠️ Gateway connection failed: ${err instanceof Error ? err.message : String(err)}`)
    console.warn('[GatewayBridge] HTTP-only tools still available. Session-context tools require Gateway connection.')
    // Don't exit - the bridge still serves HTTP tools
  }

  console.log(`[GatewayBridge] Server listening on http://127.0.0.1:${PORT}`)
  console.log(`[GatewayBridge] Endpoints: /health, /tools, /tools/invoke, /chat, /status, /reconnect`)

  // Keep process alive with periodic health check
  setInterval(() => {
    const status = gatewayClient.getStatus()
    if (!status.connected) {
      console.log('[GatewayBridge] ⚠️ Gateway disconnected, attempting reconnect...')
      gatewayClient.connect().catch(err => {
        console.error('[GatewayBridge] Reconnect failed:', err instanceof Error ? err.message : String(err))
      })
    }
  }, 30000)
}

main().catch(err => {
  console.error('[GatewayBridge] Fatal error:', err)
  process.exit(1)
})

process.on('SIGTERM', async () => {
  console.log('[GatewayBridge] Shutting down...')
  await gatewayClient.disconnect()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('[GatewayBridge] Shutting down...')
  await gatewayClient.disconnect()
  process.exit(0)
})
